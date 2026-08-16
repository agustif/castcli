// k, and the first of the two padding decisions the vectors settle.
//
// There is no published `k` to compare against — the vector array named `k` in
// `HAPCryptoTest.c` is the session key, not the multiplier (see
// `SessionKey.test.ts`). So `k` is arbitrated indirectly and conclusively:
// B = k*v + g^b, and Apple published B. Exactly one encoding of `g` reproduces
// it.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SrpVectors } from "../../src/Generated/index.ts"
import * as Group from "../../src/Srp/Group.ts"
import { hash } from "../../src/Srp/Hash.ts"
import { fromBigInt, modPow, toBigInt } from "../../src/Srp/Math/index.ts"
import { multiplier } from "../../src/Srp/Multiplier.ts"

const group = Group.rfc5054

/** B = k*v + g^b mod N, for whichever multiplier is handed in. */
const publicKeyFrom = (k: bigint): bigint =>
  ((k * toBigInt(SrpVectors.v)) + modPow(group.generator, toBigInt(SrpVectors.b), group.modulus)) %
  group.modulus

describe("multiplier", () => {
  it.effect("is the variant that reproduces Apple's B", () =>
    Effect.gen(function*() {
      const k = yield* multiplier(group)
      assert.strictEqual(
        publicKeyFrom(k),
        toBigInt(SrpVectors.B),
        "k = H(N | PAD(g)) does not reproduce the published B"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("is not the variant with an unpadded generator", () =>
    Effect.gen(function*() {
      // The rejected variant, kept as a test rather than as a sentence: `g`
      // hashed as the single octet 05, which is how M1 hashes it four
      // functions later. It produces a k that is a perfectly good 64-octet
      // digest and a B that Apple's accessory has never seen.
      //
      // This assertion is what stops someone "unifying" the two encodings.
      const unpadded = toBigInt(
        yield* hash(Group.encode(group, group.modulus), fromBigInt(group.generator))
      )
      assert.notStrictEqual(
        publicKeyFrom(unpadded),
        toBigInt(SrpVectors.B),
        "the unpadded variant also reproduces B — the vector cannot distinguish them"
      )
    }).pipe(Effect.provide(NodeServices.layer)))
})
