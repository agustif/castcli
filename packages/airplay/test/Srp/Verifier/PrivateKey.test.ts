// x, checked through the only window onto it that exists.
//
// x never appears in a vector and never goes on the wire — it exists only as
// an exponent. The published verifier is g^x, so reproducing that reproduces x,
// and it settles the whole formula at once: the separator really is a literal
// colon, the salt really is prepended rather than appended, and the inner
// digest goes in as raw octets rather than as hexadecimal text.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SrpVectors } from "../../../src/Generated/index.ts"
import * as Group from "../../../src/Srp/Group.ts"
import { modPow, toBigInt } from "../../../src/Srp/Math/index.ts"
import { privateKey } from "../../../src/Srp/Verifier/PrivateKey.ts"

const group = Group.rfc5054
const vector = {
  username: "alice",
  password: "password123",
  salt: SrpVectors.salt
}

describe("privateKey", () => {
  it.effect("reproduces Apple's verifier through g^x", () =>
    Effect.gen(function*() {
      const x = yield* privateKey(vector)
      assert.strictEqual(
        modPow(group.generator, x, group.modulus),
        toBigInt(SrpVectors.v),
        "x = H(salt | H(I | \":\" | P)) does not reproduce the published verifier"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("binds the username, so the same PIN under two identities differs", () =>
    Effect.gen(function*() {
      // What the inner hash is for. Without the username in it, `Pair-Setup`
      // and any other identity on the same accessory would share a key.
      const mine = yield* privateKey(vector)
      const theirs = yield* privateKey({ ...vector, username: "bob" })
      assert.notStrictEqual(mine, theirs)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("binds the salt, so the same PIN on two accessories differs", () =>
    Effect.gen(function*() {
      // What the outer hash is for: it is what makes a precomputed table of
      // six-digit PINs worthless.
      const here = yield* privateKey(vector)
      const there = yield* privateKey({ ...vector, salt: new Uint8Array(16) })
      assert.notStrictEqual(here, there)
    }).pipe(Effect.provide(NodeServices.layer)))
})
