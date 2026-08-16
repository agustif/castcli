// M6, against an accessory response built the way HAPPairingPairSetupGetM6
// builds one.
//
// The fixture here is the other half of the protocol written out by hand: it
// derives the encryption key and `AccessoryX` from the SRP session key using
// the salt and info strings quoted as literals from the C source, lays out
// `X || AccessoryPairingID || AccessoryLTPK`, signs it with an Ed25519 key it
// holds, and seals the sub-TLV under `PS-Msg06`. Because the constants are
// literals rather than the generated ones the implementation reads, a mistake
// in the wiring cannot be matched by the same mistake in the test — the two
// derivations would simply not agree.
//
// The negatives are the point of the file. A controller that opens the sub-TLV
// and reads the accessory's long-term key out of it without verifying the
// signature over it will pass every positive test ever written and will trust
// anything that can relay the exchange, permanently.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Result, Schema } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { PairingError, TlvType } from "../../../src/Generated/index.ts"
import { type Item, Items } from "../../../src/Tlv8/index.ts"
import { Nonce, Suite } from "../../../src/Suite/index.ts"
import { layer } from "../../../src/NodeSuite/index.ts"
import { deviceInfo } from "../../../src/PairSetup/Controller/DeviceInfo.ts"
import { finish } from "../../../src/PairSetup/Controller/Finish.ts"
import type { Exchanged } from "../../../src/PairSetup/Controller/State.ts"

const TestSuite = Layer.provide(layer, NodeCrypto.layer)

const encode = Schema.encodeEffect(Items)

/** K, as M5 carried it forward. */
const SESSION_KEY = Redacted.make(
  Uint8Array.from({ length: 64 }, (_, index) => (index * 13 + 2) & 0xff)
)

/** This controller's identity, as M5 sent it. */
const CONTROLLER_ID = new TextEncoder().encode("controller-0001")
const CONTROLLER_KEY = Uint8Array.from({ length: 32 }, (_, index) => (index + 60) & 0xff)

/** The accessory's Ed25519 seed, which only the fixture holds. */
const ACCESSORY_SEED = Redacted.make(
  Uint8Array.from({ length: 32 }, (_, index) => (index * 9 + 1) & 0xff)
)
const ACCESSORY_ID = "AA:BB:CC:DD:EE:FF"

/** `Pair-Setup-Encrypt-Salt` and its info, quoted from HAPPairingPairSetup.c. */
const encryptionKey = Effect.flatMap(Suite, (suite) =>
  suite.hkdfSha512({
    key: SESSION_KEY,
    salt: "Pair-Setup-Encrypt-Salt",
    info: "Pair-Setup-Encrypt-Info"
  }))

const state = Effect.map(encryptionKey, (key): Exchanged => ({
  srpSessionKey: SESSION_KEY,
  encryptionKey: key,
  identifier: CONTROLLER_ID,
  publicKey: CONTROLLER_KEY
}))

/**
 * An M6 as an accessory would write one.
 *
 * `salt` and `info` are parameters so that the negative test can build an
 * otherwise perfect message whose signature was made over the controller's
 * derivation rather than the accessory's — the mistake that produces a
 * signature which is genuine, and verifies against nothing.
 */
const accessoryM6 = (options: {
  readonly identifier: string
  readonly seed: Redacted.Redacted<Uint8Array>
  readonly salt: string
  readonly info: string
}) =>
  Effect.gen(function*() {
    const suite = yield* Suite
    const identifier = new TextEncoder().encode(options.identifier)
    const publicKey = yield* suite.ed25519PublicKey(options.seed)
    const x = yield* suite.hkdfSha512({
      key: SESSION_KEY,
      salt: options.salt,
      info: options.info
    })
    const signature = yield* suite.ed25519Sign({
      privateKey: options.seed,
      message: deviceInfo({ x, identifier, publicKey })
    })
    return yield* sealedM6([
      { type: TlvType.Identifier, value: identifier },
      { type: TlvType.PublicKey, value: publicKey },
      { type: TlvType.Signature, value: signature }
    ])
  })

/** The outer message: State 6 and the sub-TLV sealed under `PS-Msg06`. */
const sealedM6 = (sub: ReadonlyArray<Item>) =>
  Effect.gen(function*() {
    const suite = yield* Suite
    const sealed = yield* suite.seal({
      key: yield* encryptionKey,
      nonce: yield* Nonce.label("PS-Msg06"),
      plaintext: yield* encode(sub),
      associatedData: new Uint8Array()
    })
    return yield* encode([
      { type: TlvType.State, value: Uint8Array.of(6) },
      { type: TlvType.EncryptedData, value: sealed }
    ])
  })

const wellFormed = accessoryM6({
  identifier: ACCESSORY_ID,
  seed: ACCESSORY_SEED,
  salt: "Pair-Setup-Accessory-Sign-Salt",
  info: "Pair-Setup-Accessory-Sign-Info"
})

const item = (type: number, ...value: ReadonlyArray<number>) => ({
  type,
  value: Uint8Array.from(value)
})

const tagOf = (outcome: Result.Result<unknown, { readonly _tag: string }>): string =>
  Result.isFailure(outcome) ? outcome.failure._tag : "no failure"

describe("finish", () => {
  it.effect("returns both ends of the pairing", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const pairing = yield* finish(yield* wellFormed, yield* state)

      assert.deepStrictEqual(
        pairing.accessory.identifier,
        new TextEncoder().encode(ACCESSORY_ID)
      )
      assert.deepStrictEqual(
        pairing.accessory.publicKey,
        yield* suite.ed25519PublicKey(ACCESSORY_SEED)
      )
      // The controller's half comes from the state rather than from the
      // message, so what is recorded is what was sent and signed in M5.
      assert.deepStrictEqual(pairing.controller.identifier, CONTROLLER_ID)
      assert.deepStrictEqual(pairing.controller.publicKey, CONTROLLER_KEY)
    }).pipe(Effect.provide(TestSuite)))

  it.effect("rejects a signature made with the controller's derivation", () =>
    Effect.gen(function*() {
      // A genuine signature by the genuine accessory key over a genuine device
      // info — with `X` derived from the wrong salt and info. It is the whole
      // reason the two derivations are named separately, and the only symptom
      // of getting it wrong is this verification failing on a message that is
      // otherwise perfect.
      const outcome = yield* Effect.result(
        finish(
          yield* accessoryM6({
            identifier: ACCESSORY_ID,
            seed: ACCESSORY_SEED,
            salt: "Pair-Setup-Controller-Sign-Salt",
            info: "Pair-Setup-Controller-Sign-Info"
          }),
          yield* state
        )
      )
      assert.strictEqual(tagOf(outcome), "PairSetupSignatureRejected")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("rejects a long-term key that did not sign for itself", () =>
    Effect.gen(function*() {
      // The substitution the signature exists to stop: something that can relay
      // the exchange puts its own key in the sub-TLV. It holds the session key,
      // so the frame authenticates; it cannot produce a signature over the
      // advertised key, so this must fail.
      const suite = yield* Suite
      const impostor = Redacted.make(new Uint8Array(32).fill(7))
      const identifier = new TextEncoder().encode(ACCESSORY_ID)
      const advertised = yield* suite.ed25519PublicKey(ACCESSORY_SEED)
      const x = yield* suite.hkdfSha512({
        key: SESSION_KEY,
        salt: "Pair-Setup-Accessory-Sign-Salt",
        info: "Pair-Setup-Accessory-Sign-Info"
      })
      const signature = yield* suite.ed25519Sign({
        privateKey: impostor,
        message: deviceInfo({ x, identifier, publicKey: advertised })
      })
      const bytes = yield* sealedM6([
        { type: TlvType.Identifier, value: identifier },
        { type: TlvType.PublicKey, value: advertised },
        { type: TlvType.Signature, value: signature }
      ])

      const outcome = yield* Effect.result(finish(bytes, yield* state))
      assert.strictEqual(tagOf(outcome), "PairSetupSignatureRejected")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("refuses a tampered ciphertext instead of decoding it to nonsense", () =>
    Effect.gen(function*() {
      // ChaCha20 is a stream cipher: without the tag this would decrypt to the
      // accessory's sub-TLV with one byte changed, which is a different public
      // key or a different identifier and nothing to say so.
      const bytes = Uint8Array.from(yield* wellFormed)
      // Byte 5: past the three bytes of the State item and the type and length
      // of the encrypted one, so this is the first byte of ciphertext.
      bytes[5] = (bytes[5] ?? 0) ^ 0x01

      const outcome = yield* Effect.result(finish(bytes, yield* state))
      assert.strictEqual(tagOf(outcome), "ForgedFrame")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("refuses a sub-TLV sealed under a different session key", () =>
    Effect.gen(function*() {
      // What a controller sees if the SRP secrets diverged: the message is from
      // a real accessory and cannot be opened.
      const suite = yield* Suite
      const wrong = yield* suite.hkdfSha512({
        key: Redacted.make(new Uint8Array(64)),
        salt: "Pair-Setup-Encrypt-Salt",
        info: "Pair-Setup-Encrypt-Info"
      })
      const outcome = yield* Effect.result(
        finish(yield* wellFormed, { ...(yield* state), encryptionKey: wrong })
      )
      assert.strictEqual(tagOf(outcome), "ForgedFrame")
    }).pipe(Effect.provide(TestSuite)))
})

describe("finish on a sub-TLV that is missing something", () => {
  it.effect("says the item was missing from the sub-TLV, not from the message", () =>
    Effect.gen(function*() {
      // An accessory that sealed an identifier and a signature and left the key
      // out. The frame authenticates perfectly; there is simply nothing in it
      // to verify the signature against.
      const bytes = yield* sealedM6([
        { type: TlvType.Identifier, value: new TextEncoder().encode(ACCESSORY_ID) },
        { type: TlvType.Signature, value: new Uint8Array(64) }
      ])

      const outcome = yield* Effect.result(finish(bytes, yield* state))
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure.message : "",
        "pair-setup M6: the sub-TLV has no PublicKey item"
      )
    }).pipe(Effect.provide(TestSuite)))

  it.effect("rejects a long-term key of the wrong width before verifying with it", () =>
    Effect.gen(function*() {
      const bytes = yield* sealedM6([
        { type: TlvType.Identifier, value: new TextEncoder().encode(ACCESSORY_ID) },
        { type: TlvType.PublicKey, value: new Uint8Array(31) },
        { type: TlvType.Signature, value: new Uint8Array(64) }
      ])
      const outcome = yield* Effect.result(finish(bytes, yield* state))
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure.message : "",
        "pair-setup M6: the sub-TLV's PublicKey item is 31 bytes; expected exactly 32"
      )
    }).pipe(Effect.provide(TestSuite)))

  it.effect("rejects an identifier no accessory could have stored", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const bytes = yield* sealedM6([
        { type: TlvType.Identifier, value: new Uint8Array(37) },
        { type: TlvType.PublicKey, value: yield* suite.ed25519PublicKey(ACCESSORY_SEED) },
        { type: TlvType.Signature, value: new Uint8Array(64) }
      ])
      const outcome = yield* Effect.result(finish(bytes, yield* state))
      assert.strictEqual(tagOf(outcome), "PairSetupMalformedItem")
    }).pipe(Effect.provide(TestSuite)))
})

describe("finish on a message that is not an M6", () => {
  it.effect("reports a refusal rather than a missing encrypted item", () =>
    Effect.gen(function*() {
      const bytes = yield* encode([
        item(TlvType.State, 6),
        item(TlvType.Error, PairingError.MaxPeers)
      ])
      const outcome = yield* Effect.result(finish(bytes, yield* state))
      assert.strictEqual(tagOf(outcome), "PairSetupAccessoryRefused")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("refuses a message from another step", () =>
    Effect.gen(function*() {
      const bytes = yield* encode([item(TlvType.State, 4), item(TlvType.EncryptedData, 1, 2)])
      const outcome = yield* Effect.result(finish(bytes, yield* state))
      assert.strictEqual(tagOf(outcome), "PairSetupUnexpectedState")
    }).pipe(Effect.provide(TestSuite)))
})
