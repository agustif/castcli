// S from the sender's side, checked against the side the vectors verified.
//
// There is no client private value in Apple's vectors, so this half has no
// published output to match. What it has is `FromVerifier`, which does — so
// every case here picks an `a`, computes A from it, and requires that the two
// derivations meet. They share no arithmetic: one starts from a stored
// verifier, the other from a password.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SrpVectors } from "../../../src/Generated/index.ts"
import * as Group from "../../../src/Srp/Group.ts"
import { modPow, toBigInt } from "../../../src/Srp/Math/index.ts"
import { multiplier } from "../../../src/Srp/Multiplier.ts"
import { fromPassword } from "../../../src/Srp/Premaster/FromPassword.ts"
import { fromVerifier } from "../../../src/Srp/Premaster/FromVerifier.ts"
import { scrambler } from "../../../src/Srp/Scrambler.ts"
import { privateKey } from "../../../src/Srp/Verifier/PrivateKey.ts"

const group = Group.rfc5054

/**
 * Both derivations of S for a chosen client private value, against Apple's
 * salt, password and server private value.
 */
const both = (a: bigint) =>
  Effect.gen(function*() {
    const k = yield* multiplier(group)
    const x = yield* privateKey({
      username: "alice",
      password: "password123",
      salt: SrpVectors.salt
    })
    const v = toBigInt(SrpVectors.v)
    const b = toBigInt(SrpVectors.b)
    const clientPublic = modPow(group.generator, a, group.modulus)
    const serverPublic = ((k * v) + modPow(group.generator, b, group.modulus)) % group.modulus
    const u = yield* scrambler(group, clientPublic, serverPublic)
    return {
      client: fromPassword(group, {
        serverPublic,
        multiplier: k,
        passwordKey: x,
        privateKey: a,
        scrambler: u
      }),
      server: fromVerifier(group, { clientPublic, verifier: v, scrambler: u, privateKey: b })
    }
  }).pipe(Effect.provide(NodeServices.layer))

describe("fromPassword", () => {
  it.effect("meets fromVerifier at the same number", () =>
    Effect.gen(function*() {
      const { client, server } = yield* both(0x0123456789abcdefn)
      assert.strictEqual(client, server)
    }))

  it.effect("still meets it for the private values that make B - k*g^x negative", () =>
    Effect.gen(function*() {
      // The trap this test exists for. `B - k*g^x` is negative about half the
      // time, and `%` in JavaScript keeps the sign of the dividend, so the
      // base of the exponentiation can come out negative — which yields a
      // number, not an error, and a wrong one. Sixteen private values is
      // enough that both signs occur; a single fixed `a` would pass by luck
      // half the time, which is the worst possible test.
      const results = yield* Effect.all(
        Array.from({ length: 16 }, (_, index) => both(BigInt(index) * 0x9e3779b97f4a7c15n + 1n))
      )
      const disagreements = results.filter(({ client, server }) => client !== server).length
      assert.strictEqual(disagreements, 0, "the two derivations of S disagree")
      // And the values really are distinct, so the loop is not comparing one
      // number with itself sixteen times.
      assert.strictEqual(new Set(results.map(({ client }) => client)).size, 16)
    }))

  it.effect("does not reduce its exponent, which would be silently wrong", () =>
    Effect.gen(function*() {
      // `a + u*x` is an exponent: the modulus that could apply to it is the
      // group order, not N. Reducing it mod N is a no-op for small `a` and
      // wrong for large ones. `u*x` alone is around 1024 bits, far past N, so
      // any reduction at all would show up here as disagreement.
      const { client, server } = yield* both((1n << 255n) + 12345n)
      assert.strictEqual(client, server)
    }))
})
