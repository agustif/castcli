// The sender, checked by agreement with the accessory the vectors verified.
//
// Apple's vectors carry no client private value, so there is no published
// number for this half to match. What there is, is a server that reproduces
// Apple's B, S, K, M1 and M2 exactly — see `Server.test.ts` — so running the
// client against it and requiring that both reach the same session key, the
// same M1 and the same M2 puts the client one step from hardware-verified. The
// two derivations share no arithmetic: the accessory starts from a stored
// verifier, the sender from a typed PIN.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Result } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SrpVectors } from "../../src/Generated/index.ts"
import * as Client from "../../src/Srp/Client.ts"
import * as Group from "../../src/Srp/Group.ts"
import * as Server from "../../src/Srp/Server.ts"
import { verifier } from "../../src/Srp/Verifier/index.ts"

const group = Group.rfc5054

const USERNAME = "alice"
const PASSWORD = "password123"

/** A pinned client private value, so any failure here is reproducible. */
const CLIENT_PRIVATE = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) & 0xff)

/**
 * One exchange between the two halves, carried as far as the client's proof.
 *
 * The salt, the verifier and the accessory's private value are Apple's, so the
 * server here is the very server that reproduces the published transcript;
 * only the client is new. `password` is a parameter because the negative test
 * needs the same setup with the wrong one.
 */
const exchange = (password: string) =>
  Effect.gen(function*() {
    const server = yield* Server.make(group, {
      username: USERNAME,
      salt: SrpVectors.salt,
      verifier: SrpVectors.v,
      privateKey: Option.some(SrpVectors.b)
    })
    const client = yield* Client.make(group, {
      username: USERNAME,
      password,
      privateKey: Option.some(CLIENT_PRIVATE)
    })
    const proof = yield* client.prove({
      salt: SrpVectors.salt,
      serverPublicKey: server.publicKey
    })
    return { server, client, proof }
  })

describe("Client.make", () => {
  it.effect("puts A on the wire at the full group width", () =>
    Effect.gen(function*() {
      const { client } = yield* exchange(PASSWORD)
      assert.strictEqual(client.publicKey.length, group.byteLength)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("refuses a server public key congruent to zero", () =>
    Effect.gen(function*() {
      // The mirror of the server's check. An accessory answering with N (or
      // with zeros) would otherwise get a session key the client believes is
      // authenticated. N rather than zeros, because an implementation testing
      // `B === 0n` would let this through.
      const client = yield* Client.make(group, {
        username: USERNAME,
        password: PASSWORD,
        privateKey: Option.some(CLIENT_PRIVATE)
      })
      const outcome = yield* Effect.result(
        client.prove({
          salt: SrpVectors.salt,
          serverPublicKey: Group.encode(group, group.modulus)
        })
      )
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure._tag : "",
        "SrpInvalidPublicKey"
      )
    }).pipe(Effect.provide(NodeServices.layer)))
})

describe("client and server agreement", () => {
  it.effect("both sides reach the same session key, M1 and M2", () =>
    Effect.gen(function*() {
      const { client, proof, server } = yield* exchange(PASSWORD)
      const accepted = yield* server.verify({
        clientPublicKey: client.publicKey,
        m1: proof.m1
      })

      // The three claims, in the order they would break. A disagreement on the
      // session key means the two derivations of S diverged; a disagreement on
      // M1 with the same key means a proof field is encoded differently on the
      // two sides; a disagreement on M2 with both of those equal would mean
      // only M2 is wrong.
      assert.deepStrictEqual(accepted.sessionKey, proof.sessionKey)
      yield* proof.verifyServer(accepted.m2)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("the client's M1 is the one the vector-verified server expects", () =>
    Effect.gen(function*() {
      // Stated separately from the round trip because `verify` succeeding
      // already implies it — but if the round trip ever fails, this says
      // whether the proof or the key was the cause.
      const { client, proof, server } = yield* exchange(PASSWORD)
      const outcome = yield* Effect.result(
        server.verify({ clientPublicKey: client.publicKey, m1: proof.m1 })
      )
      assert.isTrue(Result.isSuccess(outcome), "the server rejected its own client's M1")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("agrees on a verifier this package derived, not only on Apple's", () =>
    Effect.gen(function*() {
      // The vector's verifier is a fixed 384 octets; running the whole thing
      // over a verifier computed here, with a different salt and password,
      // checks that setup and exchange agree with each other rather than both
      // agreeing with one recorded number.
      const salt = Uint8Array.from({ length: 16 }, (_, index) => index * 11)
      const password = "031-45-926"
      const v = yield* verifier(group, { username: "Pair-Setup", password, salt })
      const server = yield* Server.make(group, {
        username: "Pair-Setup",
        salt,
        verifier: v,
        privateKey: Option.none()
      })
      const client = yield* Client.make(group, {
        username: "Pair-Setup",
        password,
        privateKey: Option.none()
      })
      const proof = yield* client.prove({ salt, serverPublicKey: server.publicKey })
      const accepted = yield* server.verify({
        clientPublicKey: client.publicKey,
        m1: proof.m1
      })
      assert.deepStrictEqual(accepted.sessionKey, proof.sessionKey)
      yield* proof.verifyServer(accepted.m2)
    }).pipe(Effect.provide(NodeServices.layer)))
})

describe("a wrong password", () => {
  it.effect("produces a different M1, which the server rejects as a rejection", () =>
    Effect.gen(function*() {
      // The negative the whole exchange exists to produce. Two things are
      // asserted, and the second is the one that matters: `Effect.result`
      // catches typed failures and not defects, so a rejection that arrived as
      // a thrown exception would leave this effect dying and the test failing
      // — it cannot pass by nobody noticing. The tag is checked too, so a
      // rejection reported as, say, an invalid public key is not mistaken for
      // the right answer.
      const wrong = yield* exchange("password124")
      const right = yield* exchange(PASSWORD)
      assert.notDeepEqual(wrong.proof.m1, right.proof.m1)

      const outcome = yield* Effect.result(
        wrong.server.verify({
          clientPublicKey: wrong.client.publicKey,
          m1: wrong.proof.m1
        })
      )
      assert.isTrue(Result.isFailure(outcome), "the wrong password was accepted")
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure._tag : "",
        "SrpProofRejected"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("and the right password through the same code path is accepted", () =>
    Effect.gen(function*() {
      // Guarding the guard: if `verify` rejected everything — comparing the
      // wrong two variables would do it — the test above would pass and mean
      // nothing.
      const { client, proof, server } = yield* exchange(PASSWORD)
      const outcome = yield* Effect.result(
        server.verify({ clientPublicKey: client.publicKey, m1: proof.m1 })
      )
      assert.isTrue(Result.isSuccess(outcome), "the correct password was rejected")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("also gives a different session key, so nothing downstream would work", () =>
    Effect.gen(function*() {
      // Belt and braces on the same point: even if a caller ignored the
      // rejected proof, the key it holds is not the accessory's.
      const wrong = yield* exchange("password124")
      const right = yield* exchange(PASSWORD)
      assert.notDeepEqual(wrong.proof.sessionKey, right.proof.sessionKey)
    }).pipe(Effect.provide(NodeServices.layer)))
})

describe("a lying server", () => {
  it.effect("is caught by verifyServer, as a rejection of M2 and not of M1", () =>
    Effect.gen(function*() {
      // The half a client is tempted to skip. Without it, a device that never
      // held the verifier completes the exchange, because M1 only proves the
      // *client* knew the password.
      const { proof } = yield* exchange(PASSWORD)
      const outcome = yield* Effect.result(proof.verifyServer(new Uint8Array(64)))
      assert.isTrue(Result.isFailure(outcome), "a forged M2 was accepted")
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure.proof : "",
        "M2",
        "an M2 failure was reported as an M1 failure — a caller would retry it"
      )
    }).pipe(Effect.provide(NodeServices.layer)))
})
