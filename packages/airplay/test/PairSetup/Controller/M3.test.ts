// M3, against pinned randomness and against the accessory half of the SRP.
//
// Two independent claims, and they need different machinery.
//
// The first is about the wire: given a fixed ephemeral private value, M3 is a
// State item, the full-width A split across two TLV items because a length byte
// only reaches 255, and the 64-byte proof. That is asserted as exact bytes,
// with the expected value assembled here from the framing rules rather than
// copied from a run — the values inside come from `Srp.Client`, which is what
// this step is supposed to be putting on the wire, and the framing around them
// is what M3 itself decides.
//
// The second is about agreement: the proof M3 sends is one that `Srp.Server`
// accepts. That server is the half checked against Apple's published vectors,
// so this puts the message one step from hardware-verified without a device in
// the room.
//
// The randomness is pinned by providing a `Crypto` layer whose bytes are fixed.
// That is the whole reason `Srp.Ephemeral` draws from a service instead of from
// `node:crypto`: a pairing exchange is otherwise different every time it runs
// and none of this could be written down.

import { assert, describe, it } from "@effect/vitest"
import { Crypto, Effect, Layer, Option, Result, Schema } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { PairingError, SrpUsername, TlvType } from "../../../src/Generated/index.ts"
import { Items } from "../../../src/Tlv8/index.ts"
import { Client, Group, Server, Verifier } from "../../../src/Srp/index.ts"
import { m3 } from "../../../src/PairSetup/Controller/M3.ts"

const group = Group.rfc5054

const PIN = "123-45-678"
const SALT = Uint8Array.from({ length: 16 }, (_, index) => (index * 3 + 1) & 0xff)
/** The accessory's ephemeral private value, pinned so that B is stable too. */
const SERVER_PRIVATE = Uint8Array.from({ length: 32 }, (_, index) => (index * 5 + 9) & 0xff)

/**
 * A `Crypto` whose random bytes are fixed, over the real digest.
 *
 * The digest has to be the genuine SHA-512 — every SRP value depends on it —
 * so this replaces exactly one method of the platform service and passes the
 * rest through.
 */
const PinnedCrypto = Layer.provide(
  Layer.effect(
    Crypto.Crypto,
    Effect.map(Crypto.Crypto, (real) =>
      Crypto.make({
        randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => (index * 7 + 3) & 0xff),
        digest: (algorithm, data) => real.digest(algorithm, data)
      }))
  ),
  NodeCrypto.layer
)

const encode = Schema.encodeEffect(Items)
const decode = Schema.decodeUnknownEffect(Items)

/** An accessory's M2: its public key and the salt the verifier was made with. */
const m2Response = Effect.gen(function*() {
  const verifier = yield* Verifier.verifier(group, {
    username: SrpUsername,
    password: PIN,
    salt: SALT
  })
  const server = yield* Server.make(group, {
    username: SrpUsername,
    salt: SALT,
    verifier,
    privateKey: Option.some(SERVER_PRIVATE)
  })
  const bytes = yield* encode([
    { type: TlvType.State, value: Uint8Array.of(2) },
    { type: TlvType.PublicKey, value: server.publicKey },
    { type: TlvType.Salt, value: SALT }
  ])
  return { server, bytes }
})

const item = (type: number, ...value: ReadonlyArray<number>) => ({
  type,
  value: Uint8Array.from(value)
})

const tagOf = (outcome: Result.Result<unknown, { readonly _tag: string }>): string =>
  Result.isFailure(outcome) ? outcome.failure._tag : "no failure"

describe("m3", () => {
  it.effect("puts A and the proof on the wire, framed as TLV8 requires", () =>
    Effect.gen(function*() {
      const { bytes, server } = yield* m2Response
      const { request } = yield* m3(bytes, { pin: PIN })

      // The same values, reached independently: this is `Srp.Client` run with
      // the same pinned randomness, which is what M3 is meant to be sending.
      const client = yield* Client.make(group, {
        username: SrpUsername,
        password: PIN,
        privateKey: Option.none()
      })
      const proof = yield* client.prove({ salt: SALT, serverPublicKey: server.publicKey })

      const expected = Uint8Array.from([
        // kTLVType_State, one byte, 3.
        0x06,
        0x01,
        0x03,
        // kTLVType_PublicKey: 384 bytes is more than one length byte can
        // describe, so it is two items of the same type — 255 and then 129.
        0x03,
        0xff,
        ...client.publicKey.slice(0, 255),
        0x03,
        0x81,
        ...client.publicKey.slice(255),
        // kTLVType_Proof, SRP_PROOF_BYTES.
        0x04,
        0x40,
        ...proof.m1
      ])
      assert.deepStrictEqual(request, expected)
    }).pipe(Effect.provide(PinnedCrypto)))

  it.effect("sends a proof the vector-verified accessory accepts", () =>
    Effect.gen(function*() {
      // The claim that matters, and the one exact bytes cannot make: those
      // bytes are the ones an accessory computing the same numbers from a
      // stored verifier will agree with.
      const { bytes, server } = yield* m2Response
      const { request } = yield* m3(bytes, { pin: PIN })
      const items = yield* decode(request)

      const clientPublicKey = items.find((entry) => entry.type === TlvType.PublicKey)?.value
      const proof = items.find((entry) => entry.type === TlvType.Proof)?.value
      const accepted = yield* server.verify({
        clientPublicKey: clientPublicKey ?? new Uint8Array(),
        m1: proof ?? new Uint8Array()
      })
      assert.strictEqual(accepted.sessionKey.length, 64)
    }).pipe(Effect.provide(PinnedCrypto)))

  it.effect("carries a session key forward that the accessory also holds", () =>
    Effect.gen(function*() {
      // The state M5 will derive three keys from. If this and the accessory's
      // K ever differ, everything after M4 fails to decrypt and reads as a bad
      // setup code.
      const { bytes, server } = yield* m2Response
      const { request, state } = yield* m3(bytes, { pin: PIN })
      const items = yield* decode(request)
      const accepted = yield* server.verify({
        clientPublicKey: items.find((entry) => entry.type === TlvType.PublicKey)?.value ??
          new Uint8Array(),
        m1: items.find((entry) => entry.type === TlvType.Proof)?.value ?? new Uint8Array()
      })

      // Checked through the carried verifier rather than by comparing key
      // bytes, because that is what M5 will do with it.
      yield* state.verifyAccessoryProof(accepted.m2)
    }).pipe(Effect.provide(PinnedCrypto)))

  it.effect("rejects the accessory's proof when it is not the one expected", () =>
    Effect.gen(function*() {
      const { bytes } = yield* m2Response
      const { state } = yield* m3(bytes, { pin: PIN })
      const outcome = yield* Effect.result(state.verifyAccessoryProof(new Uint8Array(64)))
      assert.strictEqual(tagOf(outcome), "SrpProofRejected")
    }).pipe(Effect.provide(PinnedCrypto)))

  it.effect("accepts a public key the accessory sent with its leading zeros stripped", () =>
    Effect.gen(function*() {
      // `HAPPairingPairSetupGetM2` walks B forward past leading zero bytes
      // before writing it, so a value that ought to be 384 bytes arrives
      // shorter about one time in 256. A controller that insisted on the full
      // width would fail against a real device rarely and unreproducibly.
      const short = Uint8Array.from({ length: 383 }, (_, index) => (index + 1) & 0xff)
      const bytes = yield* encode([
        { type: TlvType.State, value: Uint8Array.of(2) },
        { type: TlvType.PublicKey, value: short },
        { type: TlvType.Salt, value: SALT }
      ])
      const { request } = yield* m3(bytes, { pin: PIN })
      assert.isAbove(request.length, 0)
    }).pipe(Effect.provide(PinnedCrypto)))
})

describe("m3 on a message that is not an M2", () => {
  it.effect("reports a refused exchange as a refusal, not as a missing salt", () =>
    Effect.gen(function*() {
      // An error response has no salt and no public key in it, so a reader that
      // looked for those first would report the wrong thing about a device that
      // said exactly what was wrong.
      const bytes = yield* encode([
        item(TlvType.State, 2),
        item(TlvType.Error, PairingError.Unavailable)
      ])
      const outcome = yield* Effect.result(m3(bytes, { pin: PIN }))
      assert.strictEqual(tagOf(outcome), "PairSetupAccessoryRefused")
    }).pipe(Effect.provide(PinnedCrypto)))

  it.effect("reports a wrong setup code as the error a user can act on", () =>
    Effect.gen(function*() {
      // The ADK answers M2 this way when a previous split setup has no stored
      // setup info to restore.
      const bytes = yield* encode([
        item(TlvType.State, 2),
        item(TlvType.Error, PairingError.Authentication)
      ])
      const outcome = yield* Effect.result(m3(bytes, { pin: PIN }))
      assert.strictEqual(tagOf(outcome), "PairSetupWrongSetupCode")
    }).pipe(Effect.provide(PinnedCrypto)))

  it.effect("refuses a message from another step", () =>
    Effect.gen(function*() {
      const bytes = yield* encode([item(TlvType.State, 4), { type: TlvType.Salt, value: SALT }])
      const outcome = yield* Effect.result(m3(bytes, { pin: PIN }))
      assert.strictEqual(tagOf(outcome), "PairSetupUnexpectedState")
    }).pipe(Effect.provide(PinnedCrypto)))

  it.effect("names the item when one this step needs is absent", () =>
    Effect.gen(function*() {
      const bytes = yield* encode([item(TlvType.State, 2), { type: TlvType.Salt, value: SALT }])
      const outcome = yield* Effect.result(m3(bytes, { pin: PIN }))
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure.message : "",
        "pair-setup M2: the message has no PublicKey item"
      )
    }).pipe(Effect.provide(PinnedCrypto)))

  it.effect("refuses a public key congruent to zero rather than deriving a key from it", () =>
    Effect.gen(function*() {
      // RFC 5054 §2.5.4. With B ≡ 0 the derived key stops depending on the
      // password, so an accessory answering with N would otherwise learn a key
      // this controller believes is authenticated.
      const bytes = yield* encode([
        item(TlvType.State, 2),
        { type: TlvType.PublicKey, value: Group.encode(group, group.modulus) },
        { type: TlvType.Salt, value: SALT }
      ])
      const outcome = yield* Effect.result(m3(bytes, { pin: PIN }))
      assert.strictEqual(tagOf(outcome), "SrpInvalidPublicKey")
    }).pipe(Effect.provide(PinnedCrypto)))
})
