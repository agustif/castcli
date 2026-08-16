// The accessory, driven through Apple's own transcript.
//
// Every input is Apple's — the salt, the verifier, the server private value
// `b`, the client public value `A`, the proof `M1` — and every output is
// checked against Apple's. Nothing in this file is derived from anything else
// in this package, which is what makes it the anchor the client half is then
// measured against.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Result } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SrpVectors } from "../../src/Generated/index.ts"
import * as Group from "../../src/Srp/Group.ts"
import * as Server from "../../src/Srp/Server.ts"

const group = Group.rfc5054

/** The accessory as Apple's vector configured it. */
const accessory = Server.make(group, {
  username: "alice",
  salt: SrpVectors.salt,
  verifier: SrpVectors.v,
  privateKey: Option.some(SrpVectors.b)
})

describe("Server.make", () => {
  it.effect("produces Apple's B", () =>
    Effect.gen(function*() {
      const server = yield* accessory
      assert.deepStrictEqual(server.publicKey, SrpVectors.B)
    }).pipe(Effect.provide(NodeServices.layer)))
})

describe("Server.verify", () => {
  it.effect("reaches Apple's session key and answers with Apple's M2", () =>
    Effect.gen(function*() {
      const server = yield* accessory
      const accepted = yield* server.verify({
        clientPublicKey: SrpVectors.A,
        m1: SrpVectors.m1
      })
      // K first: if this is wrong, M2 being wrong says nothing new.
      assert.deepStrictEqual(accepted.sessionKey, SrpVectors.k)
      assert.deepStrictEqual(accepted.m2, SrpVectors.m2)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a wrong proof as a typed failure, not an exception", () =>
    Effect.gen(function*() {
      // The shape of this assertion is the point. `Effect.result` catches
      // typed failures and *not* defects, so a rejection that arrived as a
      // thrown error would leave the effect dying and this test failing rather
      // than passing quietly. The tag is then checked, so a rejection reported
      // as some other error is not mistaken for success either.
      const server = yield* accessory
      const outcome = yield* Effect.result(
        server.verify({ clientPublicKey: SrpVectors.A, m1: new Uint8Array(64) })
      )
      assert.isTrue(Result.isFailure(outcome), "a wrong M1 was accepted")
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure._tag : "",
        "SrpProofRejected"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("that rejection can actually fail: the same assertion passes the right proof", () =>
    Effect.gen(function*() {
      // Guarding the guard. If `verify` failed for every input — a mistake as
      // simple as comparing the wrong two variables — the test above would
      // pass and mean nothing. This is the same code path with the correct
      // proof, asserted to succeed.
      const server = yield* accessory
      const outcome = yield* Effect.result(
        server.verify({ clientPublicKey: SrpVectors.A, m1: SrpVectors.m1 })
      )
      assert.isTrue(Result.isSuccess(outcome), "the correct M1 was rejected")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("refuses a client public key congruent to zero", () =>
    Effect.gen(function*() {
      // RFC 5054 §2.5.4. Without this the premaster secret is 0 whatever the
      // verifier is, so an attacker who never knew the password derives the
      // same session key and the exchange completes. `N` itself is used rather
      // than a buffer of zeros, because the check is on the residue and an
      // implementation testing `A === 0n` would let this through.
      const server = yield* accessory
      const outcome = yield* Effect.result(
        server.verify({
          clientPublicKey: Group.encode(group, group.modulus),
          m1: SrpVectors.m1
        })
      )
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure._tag : "",
        "SrpInvalidPublicKey"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reports a zero public key differently from a wrong password", () =>
    Effect.gen(function*() {
      // Conflating them is how an attack gets reported to a user as "check the
      // code on your television".
      const server = yield* accessory
      const attack = yield* Effect.result(
        server.verify({ clientPublicKey: new Uint8Array(384), m1: SrpVectors.m1 })
      )
      const typo = yield* Effect.result(
        server.verify({ clientPublicKey: SrpVectors.A, m1: new Uint8Array(64) })
      )
      assert.notStrictEqual(
        Result.isFailure(attack) ? attack.failure._tag : "a",
        Result.isFailure(typo) ? typo.failure._tag : "b"
      )
    }).pipe(Effect.provide(NodeServices.layer)))
})
