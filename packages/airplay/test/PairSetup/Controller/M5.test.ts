// M5, checked the way the accessory checks it.
//
// `HAPPairingPairSetupProcessM5` opens the sub-TLV under a key derived from the
// SRP session key, reads three items out of it and verifies the signature over
// `X || iOSDevicePairingID || iOSDeviceLTPK`. This file does exactly that to
// the request M5 produces, and it derives its keys from the salt and info
// strings quoted as literals from that C file rather than from the generated
// constants the implementation uses. That is what keeps the test from agreeing
// with a wiring mistake: if M5 sealed under the accessory's salt, or signed
// over the encryption key instead of the signing key, everything here would
// still be self-consistent and none of it would open.
//
// The SRP is not re-run. M5 takes the session key and the proof-checker as
// state, so both can be supplied directly — which is the point of the state
// being an ordinary value, and it keeps this file about M5 rather than about
// arithmetic that `Srp` already proves.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Result, Schema } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { PairingError, TlvType } from "../../../src/Generated/index.ts"
import { Items } from "../../../src/Tlv8/index.ts"
import { Nonce, Suite } from "../../../src/Suite/index.ts"
import { layer } from "../../../src/NodeSuite/index.ts"
import { Errors as SrpErrors } from "../../../src/Srp/index.ts"
import { deviceInfo } from "../../../src/PairSetup/Controller/DeviceInfo.ts"
import type { Identity } from "../../../src/PairSetup/Controller/Identity.ts"
import { m5 } from "../../../src/PairSetup/Controller/M5.ts"
import type { Proved } from "../../../src/PairSetup/Controller/State.ts"

const TestSuite = Layer.provide(layer, NodeCrypto.layer)

const encode = Schema.encodeEffect(Items)
const decode = Schema.decodeUnknownEffect(Items)

/** K, as it would arrive from M3. Its provenance does not matter to M5. */
const SESSION_KEY = Redacted.make(
  Uint8Array.from({ length: 64 }, (_, index) => (index * 11 + 5) & 0xff)
)

/** The accessory's M2 proof, in this test whatever we say it is. */
const ACCESSORY_PROOF = Uint8Array.from({ length: 64 }, (_, index) => (index * 3) & 0xff)

const SEED = Redacted.make(Uint8Array.from({ length: 32 }, (_, index) => (index + 17) & 0xff))

const IDENTIFIER = "5b0f9a3e-6d3c-4a1e-9c60-2f8a0b7d4e12"

/**
 * The state M3 would have produced: the session key, and a proof-checker that
 * accepts exactly one value.
 */
const state: Proved = {
  srpSessionKey: SESSION_KEY,
  verifyAccessoryProof: (proof) =>
    proof.length === ACCESSORY_PROOF.length &&
      proof.every((byte, index) => byte === ACCESSORY_PROOF[index])
      ? Effect.void
      : Effect.fail(new SrpErrors.ProofRejected({ proof: "M2" }))
}

const identity = (identifier: string) =>
  Effect.gen(function*() {
    const suite = yield* Suite
    return {
      identifier,
      keys: { publicKey: yield* suite.ed25519PublicKey(SEED), privateKey: SEED }
    } satisfies Identity
  })

const m4Response = (proof: Uint8Array) =>
  encode([
    { type: TlvType.State, value: Uint8Array.of(4) },
    { type: TlvType.Proof, value: proof }
  ])

const item = (type: number, ...value: ReadonlyArray<number>) => ({
  type,
  value: Uint8Array.from(value)
})

const tagOf = (outcome: Result.Result<unknown, { readonly _tag: string }>): string =>
  Result.isFailure(outcome) ? outcome.failure._tag : "no failure"

/** What the accessory reads: the encrypted item out of the request. */
const sealedOf = (request: Uint8Array) =>
  Effect.map(
    decode(request),
    (items) =>
      items.find((entry) => entry.type === TlvType.EncryptedData)?.value ?? new Uint8Array()
  )

describe("m5", () => {
  it.effect("sends State 5 and one encrypted item, and nothing in the clear", () =>
    Effect.gen(function*() {
      const { request } = yield* m5(yield* m4Response(ACCESSORY_PROOF), {
        state,
        identity: yield* identity(IDENTIFIER)
      })
      const items = yield* decode(request)
      assert.deepStrictEqual(items.map((entry) => entry.type), [
        TlvType.State,
        TlvType.EncryptedData
      ])
      // The identifier and the public key are inside the sealed item, not
      // beside it. A controller that also sent them in the clear would hand an
      // observer the pairing it just made private.
      assert.deepStrictEqual(items[0]?.value, Uint8Array.of(5))
    }).pipe(Effect.provide(TestSuite)))

  it.effect("seals the sub-TLV under the key HAPPairingPairSetupGetM4 derives", () =>
    Effect.gen(function*() {
      const { request } = yield* m5(yield* m4Response(ACCESSORY_PROOF), {
        state,
        identity: yield* identity(IDENTIFIER)
      })
      const suite = yield* Suite

      // Literals, quoted from the C source, so that a wrong constant in the
      // implementation cannot be matched by the same wrong constant here.
      const key = yield* suite.hkdfSha512({
        key: SESSION_KEY,
        salt: "Pair-Setup-Encrypt-Salt",
        info: "Pair-Setup-Encrypt-Info"
      })
      const plaintext = yield* suite.open({
        key,
        nonce: yield* Nonce.label("PS-Msg05"),
        ciphertextAndTag: yield* sealedOf(request),
        associatedData: new Uint8Array()
      })
      const sub = yield* decode(plaintext)
      assert.deepStrictEqual(sub.map((entry) => entry.type), [
        TlvType.Identifier,
        TlvType.PublicKey,
        TlvType.Signature
      ])
    }).pipe(Effect.provide(TestSuite)))

  it.effect("signs the device info the accessory will verify", () =>
    Effect.gen(function*() {
      // `HAPPairingPairSetupProcessM5`, reproduced: derive X with the
      // controller's salt and info, lay out X || pairingID || LTPK, and verify
      // the signature against the LTPK that arrived beside it.
      const { request } = yield* m5(yield* m4Response(ACCESSORY_PROOF), {
        state,
        identity: yield* identity(IDENTIFIER)
      })
      const suite = yield* Suite
      const key = yield* suite.hkdfSha512({
        key: SESSION_KEY,
        salt: "Pair-Setup-Encrypt-Salt",
        info: "Pair-Setup-Encrypt-Info"
      })
      const sub = yield* decode(
        yield* suite.open({
          key,
          nonce: yield* Nonce.label("PS-Msg05"),
          ciphertextAndTag: yield* sealedOf(request),
          associatedData: new Uint8Array()
        })
      )
      const valueOf = (type: number) =>
        sub.find((entry) => entry.type === type)?.value ?? new Uint8Array()

      const identifier = valueOf(TlvType.Identifier)
      const publicKey = valueOf(TlvType.PublicKey)
      assert.deepStrictEqual(identifier, new TextEncoder().encode(IDENTIFIER))
      assert.deepStrictEqual(publicKey, yield* suite.ed25519PublicKey(SEED))

      const x = yield* suite.hkdfSha512({
        key: SESSION_KEY,
        salt: "Pair-Setup-Controller-Sign-Salt",
        info: "Pair-Setup-Controller-Sign-Info"
      })
      assert.isTrue(
        yield* suite.ed25519Verify({
          publicKey,
          message: deviceInfo({ x, identifier, publicKey }),
          signature: valueOf(TlvType.Signature)
        }),
        "the accessory would have rejected this signature"
      )
    }).pipe(Effect.provide(TestSuite)))

  it.effect("carries both keys forward, the second derived once rather than twice", () =>
    Effect.gen(function*() {
      const { state: exchanged } = yield* m5(yield* m4Response(ACCESSORY_PROOF), {
        state,
        identity: yield* identity(IDENTIFIER)
      })
      const suite = yield* Suite
      assert.deepStrictEqual(
        Redacted.value(exchanged.encryptionKey),
        Redacted.value(
          yield* suite.hkdfSha512({
            key: SESSION_KEY,
            salt: "Pair-Setup-Encrypt-Salt",
            info: "Pair-Setup-Encrypt-Info"
          })
        )
      )
      // K travels on because M6's signature is over a value derived from it
      // with the *accessory's* salt, which cannot be derived until M6 arrives.
      assert.deepStrictEqual(
        Redacted.value(exchanged.srpSessionKey),
        Redacted.value(SESSION_KEY)
      )
    }).pipe(Effect.provide(TestSuite)))
})

describe("m5 on an M4 that does not check out", () => {
  it.effect("refuses to send anything when the accessory's proof is wrong", () =>
    Effect.gen(function*() {
      // The half of the authentication a controller is tempted to skip. Until
      // this passes, nothing has shown that the peer holds the verifier, and
      // everything M5 sends introduces a long-term identity to it.
      const outcome = yield* Effect.result(
        m5(yield* m4Response(new Uint8Array(64)), {
          state,
          identity: yield* identity(IDENTIFIER)
        })
      )
      assert.strictEqual(tagOf(outcome), "SrpProofRejected")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("checks the accessory's proof before it looks at our own identity", () =>
    Effect.gen(function*() {
      // Both are wrong here. The one reported is the peer's, because that is
      // the one that says whether to keep talking at all.
      const outcome = yield* Effect.result(
        m5(yield* m4Response(new Uint8Array(64)), {
          state,
          identity: yield* identity("x".repeat(37))
        })
      )
      assert.strictEqual(tagOf(outcome), "SrpProofRejected")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("rejects a proof of the wrong length rather than passing it on", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(
        m5(yield* m4Response(new Uint8Array(63)), {
          state,
          identity: yield* identity(IDENTIFIER)
        })
      )
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure.message : "",
        "pair-setup M4: the message's Proof item is 63 bytes; expected exactly 64"
      )
    }).pipe(Effect.provide(TestSuite)))

  it.effect("reports a refusal as a refusal", () =>
    Effect.gen(function*() {
      const bytes = yield* encode([
        item(TlvType.State, 4),
        item(TlvType.Error, PairingError.Authentication)
      ])
      const outcome = yield* Effect.result(
        m5(bytes, { state, identity: yield* identity(IDENTIFIER) })
      )
      assert.strictEqual(tagOf(outcome), "PairSetupWrongSetupCode")
    }).pipe(Effect.provide(TestSuite)))
})

describe("m5 with an identity the accessory could not store", () => {
  it.effect("refuses an identifier longer than HAPPairingID", () =>
    Effect.gen(function*() {
      // The ADK answers an over-long identifier by abandoning the procedure
      // with no error TLV at all, so a controller that sent one would see the
      // exchange simply stop.
      const outcome = yield* Effect.result(
        m5(yield* m4Response(ACCESSORY_PROOF), {
          state,
          identity: yield* identity("x".repeat(37))
        })
      )
      assert.strictEqual(tagOf(outcome), "PairSetupIdentifierTooLong")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("measures the identifier in bytes, not in characters", () =>
    Effect.gen(function*() {
      // Ten characters and forty bytes: an identifier a count of characters
      // would wave through and no accessory could store.
      const identifier = "\u{1F4FA}".repeat(10)
      assert.strictEqual(identifier.length, 20)
      const outcome = yield* Effect.result(
        m5(yield* m4Response(ACCESSORY_PROOF), {
          state,
          identity: yield* identity(identifier)
        })
      )
      assert.strictEqual(tagOf(outcome), "PairSetupIdentifierTooLong")
    }).pipe(Effect.provide(TestSuite)))
})
