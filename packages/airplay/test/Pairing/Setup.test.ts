// Pair-setup, both halves, end to end, with no television in the room.
//
// Every other test in this package checks one piece against a vector or against
// its own inverse. This is the one that checks the pieces against *each other*:
// a real controller — `m1`, `m3`, `m5`, `finish`, unmodified — talking to an
// emulated accessory, each side's output handed to the other as the bytes it
// would have been on the wire, from a setup code on a screen to two devices
// holding each other's long-term public key.
//
// That is the only verification available here and it is deliberate rather than
// second best. Touching the user's television is forbidden, so agreement with
// hardware cannot be demonstrated; what can be demonstrated is agreement between
// two independently written halves, one of which — `Srp.Server` — is itself
// checked against numbers a real HomeKit accessory produced. A mistake that this
// file cannot see is one both halves make identically, which is why the
// accessory quotes its constants from Apple's C source instead of importing the
// ones the controller uses.
//
// The green tests below say the parts fit. They do not say anything is checked,
// which is what the second half of this file is for.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Redacted } from "effect"
import { PairingError, TlvType } from "../../src/Generated/index.ts"
import { Nonce, Suite } from "../../src/Suite/index.ts"
import { ADMIN } from "../../src/PairSetup/Accessory/Pairing.ts"
import { finish, type Identity, m1, m3, m5 } from "../../src/PairSetup/Controller/index.ts"
import * as Accessory from "./Accessory.ts"
import {
  ACCESSORY_PAIRING_ID,
  ACCESSORY_SEED,
  CONTROLLER_IDENTIFIER,
  CONTROLLER_SEED,
  decode,
  encode,
  flip,
  item,
  Pairing,
  SETUP_CODE,
  tagOf,
  valueOf,
  WRONG_SETUP_CODE
} from "./Support.ts"

/** The controller's long-term identity, from the seed the whole suite shares. */
const controller = Effect.map(
  Suite.use((suite) => suite.ed25519PublicKey(CONTROLLER_SEED)),
  (publicKey): Identity => ({
    identifier: CONTROLLER_IDENTIFIER,
    keys: { publicKey, privateKey: CONTROLLER_SEED }
  })
)

/**
 * A television with the setup code on its screen.
 *
 * Three attempts rather than a hundred: the lockout is the same code path at
 * either number, and a test that had to be wrong ninety-nine times before
 * proving anything is one nobody runs.
 */
const television = Accessory.make({
  setupCode: SETUP_CODE,
  pairingId: ACCESSORY_PAIRING_ID,
  seed: ACCESSORY_SEED,
  attemptLimit: 3
})

/**
 * The six messages, in order, each fed to the other side as bytes.
 *
 * Returned along with the transcript, because "did it pair" and "did it pair the
 * same way" are different questions and the second one is the one that catches a
 * derivation that quietly depends on the time of day.
 */
const pairWith = (options: {
  readonly accessory: Accessory.Accessory
  readonly pin: string
}) =>
  Effect.gen(function*() {
    const identity = yield* controller

    const request1 = yield* m1({ flags: [] })
    const response2 = yield* options.accessory.respond(request1)

    const { request: request3, state: proved } = yield* m3(response2, { pin: options.pin })
    const response4 = yield* options.accessory.respond(request3)

    const { request: request5, state: exchanged } = yield* m5(response4, { state: proved, identity })
    const response6 = yield* options.accessory.respond(request5)

    const pairing = yield* finish(response6, exchanged)
    return {
      identity,
      pairing,
      transcript: [request1, response2, request3, response4, request5, response6]
    }
  })

/** The whole exchange, from a fresh accessory, with the right code. */
const exchange = Effect.flatMap(television, (accessory) =>
  Effect.map(
    pairWith({ accessory, pin: SETUP_CODE }),
    (result) => ({ ...result, accessory })
  ))

describe("pair-setup, controller against accessory", () => {
  it.effect("reaches a pairing from a setup code and nothing else", () =>
    Effect.gen(function*() {
      const { accessory, pairing } = yield* exchange

      // What the controller learned about the television.
      assert.deepStrictEqual(
        pairing.accessory.identifier,
        new TextEncoder().encode(ACCESSORY_PAIRING_ID)
      )
      assert.deepStrictEqual(pairing.accessory.publicKey, accessory.identity.keys.publicKey)

      // And what it believes it told the television about itself.
      assert.deepStrictEqual(
        pairing.controller.identifier,
        new TextEncoder().encode(CONTROLLER_IDENTIFIER)
      )
    }).pipe(Effect.provide(Pairing)))

  it.effect("leaves both ends holding the other's long-term key, and agreeing", () =>
    Effect.gen(function*() {
      const { accessory, identity, pairing } = yield* exchange
      const remembered = yield* accessory.paired

      // The assertion the whole exchange exists to make. Each side's record of
      // the other has to match what the other actually holds — a pairing where
      // only one direction lines up is a pairing that completes today and fails
      // at the first pair-verify, with nothing pointing back here.
      assert.deepStrictEqual(
        Option.map(remembered, (stored) => stored.publicKey),
        Option.some(identity.keys.publicKey)
      )
      assert.deepStrictEqual(
        Option.map(remembered, (stored) => stored.identifier),
        Option.some(pairing.controller.identifier)
      )
      assert.deepStrictEqual(
        Option.map(remembered, (stored) => stored.permissions),
        Option.some(ADMIN)
      )
      assert.deepStrictEqual(pairing.accessory.publicKey, accessory.identity.keys.publicKey)
    }).pipe(Effect.provide(Pairing)))

  it.effect("puts nothing in the clear that the pairing depends on", () =>
    Effect.gen(function*() {
      const { identity, transcript } = yield* exchange
      const [, , , , request5] = transcript
      const items = yield* decode(request5 ?? new Uint8Array())

      // M5 is a State and one sealed item. The identifier and the long-term key
      // are inside it; a controller that also sent them beside it would hand an
      // observer the pairing it had just gone to six messages' trouble to make
      // private.
      assert.deepStrictEqual(items.map((entry) => entry.type), [
        TlvType.State,
        TlvType.EncryptedData
      ])
      const sealed = valueOf(items, TlvType.EncryptedData)
      const contains = (needle: Uint8Array) =>
        sealed.some((_, at) => needle.every((expected, offset) => sealed[at + offset] === expected))
      assert.isFalse(
        contains(identity.keys.publicKey),
        "the controller's long-term public key appears verbatim in the ciphertext"
      )
    }).pipe(Effect.provide(Pairing)))

  it.effect("replays byte for byte when the randomness is pinned", () =>
    Effect.gen(function*() {
      // Two separate builds of the layer, so each starts the generator over.
      // This is what makes every other assertion in this file worth making: a
      // protocol test whose bytes differ per run can say the two ends agreed and
      // cannot say what they agreed on.
      const first = yield* Effect.provide(exchange, Pairing)
      const second = yield* Effect.provide(exchange, Pairing)
      assert.deepStrictEqual(first.transcript, second.transcript)
    }))

  it.effect("draws different randomness for each side rather than one fixed value", () =>
    Effect.gen(function*() {
      // The failure a fixed-bytes `Crypto` layer would hide. If the controller's
      // SRP `a` and the accessory's `b` were the same 32 octets, A and B would be
      // related in a way no real exchange produces, and the whole thing would
      // still pass — see `PairVerify/Ephemeral/KeyPair.ts`, which warns about
      // exactly this for its own scalars.
      const { transcript } = yield* exchange
      const [, response2, request3] = transcript
      const b = valueOf(yield* decode(response2 ?? new Uint8Array()), TlvType.PublicKey)
      const a = valueOf(yield* decode(request3 ?? new Uint8Array()), TlvType.PublicKey)
      assert.notDeepEqual(a, b)
      assert.strictEqual(a.length, 384, "A is sent at the full group width")
    }).pipe(Effect.provide(Pairing)))
})

describe("pair-setup with the wrong setup code", () => {
  it.effect("fails at M4, and says the code was wrong rather than that something was", () =>
    Effect.gen(function*() {
      const accessory = yield* television
      const outcome = yield* Effect.result(pairWith({ accessory, pin: WRONG_SETUP_CODE }))

      // Not "some error". `kHAPPairingError_Authentication` at M4 is the one
      // failure in this exchange a user can act on, and an implementation that
      // folded it in with "the accessory is busy" would tell someone to retype a
      // code that was never the problem.
      assert.strictEqual(tagOf(outcome), "PairSetupWrongSetupCode")
      assert.strictEqual(
        outcome._tag === "Failure" ? outcome.failure.message : "",
        "pair-setup M4: the accessory rejected the setup code"
      )
    }).pipe(Effect.provide(Pairing)))

  it.effect("stores no pairing, and counts the attempt", () =>
    Effect.gen(function*() {
      const accessory = yield* television
      yield* Effect.result(pairWith({ accessory, pin: WRONG_SETUP_CODE }))

      assert.deepStrictEqual(yield* accessory.paired, Option.none())
      assert.strictEqual(yield* accessory.failures, 1)
    }).pipe(Effect.provide(Pairing)))

  it.effect("lets the next attempt with the right code succeed, and forgets the failure", () =>
    Effect.gen(function*() {
      // The refusal resets the accessory to AwaitingM1 — HAP abandons the
      // procedure on every error it reports — so a retry is a whole new
      // exchange with a fresh salt and a fresh `b`, not a second guess at the
      // same one.
      const accessory = yield* television
      yield* Effect.result(pairWith({ accessory, pin: WRONG_SETUP_CODE }))
      const { pairing } = yield* pairWith({ accessory, pin: SETUP_CODE })

      assert.deepStrictEqual(pairing.accessory.publicKey, accessory.identity.keys.publicKey)
      assert.strictEqual(yield* accessory.failures, 0, "a success forgets the failures before it")
    }).pipe(Effect.provide(Pairing)))

  it.effect("stops answering once the attempts are exhausted, and says why", () =>
    Effect.gen(function*() {
      const accessory = yield* television
      yield* Effect.result(pairWith({ accessory, pin: WRONG_SETUP_CODE }))
      yield* Effect.result(pairWith({ accessory, pin: WRONG_SETUP_CODE }))
      yield* Effect.result(pairWith({ accessory, pin: WRONG_SETUP_CODE }))

      // The fourth attempt is refused at M2, before the salt is sent — so a
      // locked-out controller learns nothing it could work from. And it is
      // refused even for the *right* code, which is what a lockout means.
      const outcome = yield* Effect.result(pairWith({ accessory, pin: SETUP_CODE }))
      assert.strictEqual(tagOf(outcome), "PairSetupAccessoryRefused")
      assert.strictEqual(
        outcome._tag === "Failure" ? outcome.failure.message : "",
        `pair-setup M2: the accessory declined with MaxTries (${PairingError.MaxTries})`
      )
    }).pipe(Effect.provide(Pairing)))
})

describe("pair-setup against an accessory that cannot prove itself", () => {
  it.effect("refuses to send M5 when the accessory's own proof does not check out", () =>
    Effect.gen(function*() {
      // The half of the authentication a controller is tempted to skip. Until
      // M4's proof verifies, the accessory has proved nothing at all, and M5 is
      // where the controller hands over the identity it will be trusted by.
      const accessory = yield* television
      const identity = yield* controller

      const response2 = yield* accessory.respond(yield* m1({ flags: [] }))
      const { request: request3, state: proved } = yield* m3(response2, { pin: SETUP_CODE })
      const response4 = yield* accessory.respond(request3)

      const items = yield* decode(response4)
      const forged = yield* encode([
        item(TlvType.State, Uint8Array.of(4)),
        item(TlvType.Proof, flip(valueOf(items, TlvType.Proof), 0))
      ])

      const outcome = yield* Effect.result(m5(forged, { state: proved, identity }))
      assert.strictEqual(tagOf(outcome), "SrpProofRejected")
    }).pipe(Effect.provide(Pairing)))

  it.effect("rejects an M6 whose signature is over a key the accessory does not hold", () =>
    Effect.gen(function*() {
      // The check that binds the long-term key to the setup code. Without it,
      // anything able to relay the SRP exchange could substitute its own key in
      // M6, and every pair-verify afterwards would authenticate the relay —
      // successfully, forever.
      const accessory = yield* television
      const identity = yield* controller
      const suite = yield* Suite

      const response2 = yield* accessory.respond(yield* m1({ flags: [] }))
      const { request: request3, state: proved } = yield* m3(response2, { pin: SETUP_CODE })
      const response4 = yield* accessory.respond(request3)
      const { request: request5, state: exchanged } = yield* m5(response4, { state: proved, identity })
      const response6 = yield* accessory.respond(request5)

      // Re-seal M6 with a different long-term key in it and the accessory's
      // signature left as it was — which is exactly what a relay would produce,
      // since it cannot sign for a key it invented.
      const sub = yield* decode(
        yield* suite.open({
          key: exchanged.encryptionKey,
          nonce: yield* Nonce.label("PS-Msg06"),
          ciphertextAndTag: valueOf(yield* decode(response6), TlvType.EncryptedData),
          associatedData: new Uint8Array()
        })
      )
      const impostor = yield* suite.ed25519PublicKey(
        Redacted.make(new Uint8Array(32).fill(0x2a))
      )
      const resealed = yield* suite.seal({
        key: exchanged.encryptionKey,
        nonce: yield* Nonce.label("PS-Msg06"),
        plaintext: yield* encode([
          item(TlvType.Identifier, valueOf(sub, TlvType.Identifier)),
          item(TlvType.PublicKey, impostor),
          item(TlvType.Signature, valueOf(sub, TlvType.Signature))
        ]),
        associatedData: new Uint8Array()
      })
      const substituted = yield* encode([
        item(TlvType.State, Uint8Array.of(6)),
        item(TlvType.EncryptedData, resealed)
      ])

      const outcome = yield* Effect.result(finish(substituted, exchanged))
      assert.strictEqual(tagOf(outcome), "PairSetupSignatureRejected")
    }).pipe(Effect.provide(Pairing)))
})

describe("pair-setup against a message that was altered in flight", () => {
  it.effect("fails to authenticate a tampered M5 rather than parsing what falls out", () =>
    Effect.gen(function*() {
      const accessory = yield* television
      const identity = yield* controller

      const response2 = yield* accessory.respond(yield* m1({ flags: [] }))
      const { request: request3, state: proved } = yield* m3(response2, { pin: SETUP_CODE })
      const response4 = yield* accessory.respond(request3)
      const { request: request5 } = yield* m5(response4, { state: proved, identity })

      // One bit, somewhere in the sealed sub-TLV. ChaCha20 is a stream cipher:
      // without the tag this decrypts to plaintext-shaped bytes and the
      // accessory would go on to parse noise as a TLV8 payload.
      const items = yield* decode(request5)
      const tampered = yield* encode([
        item(TlvType.State, Uint8Array.of(5)),
        item(TlvType.EncryptedData, flip(valueOf(items, TlvType.EncryptedData), 3))
      ])

      const outcome = yield* Effect.result(accessory.respond(tampered))
      assert.strictEqual(tagOf(outcome), "ForgedFrame")
      assert.deepStrictEqual(yield* accessory.paired, Option.none())
    }).pipe(Effect.provide(Pairing)))

  it.effect("refuses a message that announces a step the accessory is not at", () =>
    Effect.gen(function*() {
      // The ADK carries `A`, `B`, `K` and the session key as live buffers on the
      // session, so an M5 arriving before M3 decrypts against a key of zeroes and
      // fails four messages from the mistake. Here the keys do not exist yet, so
      // it is refused at the dispatch.
      const accessory = yield* television
      const outcome = yield* Effect.result(
        accessory.respond(
          yield* encode([
            item(TlvType.State, Uint8Array.of(5)),
            item(TlvType.EncryptedData, new Uint8Array(32))
          ])
        )
      )
      assert.strictEqual(tagOf(outcome), "PairSetupUnexpectedState")
    }).pipe(Effect.provide(Pairing)))

  it.effect("does not accept the same M5 twice", () =>
    Effect.gen(function*() {
      // A replayed message is a well-formed one that authenticates perfectly —
      // it was written by the holder of the key, under the right nonce, and
      // nothing about the bytes says it has been seen before. What rejects it is
      // the state machine: M6 returns the accessory to AwaitingM1, exactly as the
      // ADK resets its session, so the second copy arrives at a step that is not
      // expecting it and there are no keys left to open it with.
      //
      // The same replay against a *control channel* is a different question with
      // a different answer — the frame counter, which is not exercised here
      // because nothing has built that channel yet.
      const accessory = yield* television
      const identity = yield* controller

      const response2 = yield* accessory.respond(yield* m1({ flags: [] }))
      const { request: request3, state: proved } = yield* m3(response2, { pin: SETUP_CODE })
      const response4 = yield* accessory.respond(request3)
      const { request: request5 } = yield* m5(response4, { state: proved, identity })
      yield* accessory.respond(request5)

      const outcome = yield* Effect.result(accessory.respond(request5))
      assert.strictEqual(tagOf(outcome), "PairSetupUnexpectedState")
    }).pipe(Effect.provide(Pairing)))
})
