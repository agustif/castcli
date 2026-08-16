// K, and the reading of the vector file that had to be settled before anything
// else could be.
//
// `HAPCryptoTest.c` has an array called `srp_k`. There are two 64-octet
// SHA-512 outputs in SRP that the literature calls `k` — the SRP-6a multiplier
// H(N | PAD(g)), and the session key H(S) — and taking the array for the wrong
// one produces an implementation that fails inside M1 while the bug is in the
// multiplier, or the reverse. The call sequence in the vector file
// (`HAP_srp_session_key(_k, S)`) says which it is; these assertions confirm it
// arithmetically, which is stronger than reading a macro name.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SrpVectors } from "../../src/Generated/index.ts"
import * as Group from "../../src/Srp/Group.ts"
import { toBigInt } from "../../src/Srp/Math/index.ts"
import { multiplier } from "../../src/Srp/Multiplier.ts"
import { sessionKey } from "../../src/Srp/SessionKey.ts"

const group = Group.rfc5054

describe("sessionKey", () => {
  it.effect("reproduces the vector's `k` from the vector's S", () =>
    Effect.gen(function*() {
      const K = yield* sessionKey(group, toBigInt(SrpVectors.S))
      assert.deepStrictEqual(K, SrpVectors.k)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("and the SRP-6a multiplier does not — they are different values", () =>
    Effect.gen(function*() {
      const k = yield* multiplier(group)
      assert.notStrictEqual(
        toBigInt(SrpVectors.k),
        k,
        "the vector's `k` is the multiplier after all — every reading below is wrong"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("is a digest, not the premaster secret passed through", () =>
    Effect.gen(function*() {
      // Handing S to HKDF instead of K is wrong in a way that still produces
      // bytes and still interoperates with a second implementation that made
      // the same mistake.
      const K = yield* sessionKey(group, toBigInt(SrpVectors.S))
      assert.strictEqual(K.length, 64)
      assert.notStrictEqual(K.length, SrpVectors.S.length)
    }).pipe(Effect.provide(NodeServices.layer)))
})
