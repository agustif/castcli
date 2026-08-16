// H(N) XOR H(g), and the encoding of `g` that the vectors chose.
//
// The arbitration itself lives in `M1.test.ts`, because M1 is the published
// value. What is asserted here is the narrower claim that this function really
// does hash `g` as one octet — so that if someone changes it to the padded
// form, the failure is reported here, next to the comment explaining why, and
// not only as an unexplained mismatch four functions away.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import * as Group from "../../../src/Srp/Group.ts"
import { hash } from "../../../src/Srp/Hash.ts"
import { fromBigInt } from "../../../src/Srp/Math/index.ts"
import { groupDigest } from "../../../src/Srp/Proof/GroupDigest.ts"

const group = Group.rfc5054

const xor = (left: Uint8Array, right: Uint8Array): Uint8Array =>
  Uint8Array.from(left, (octet, index) => octet ^ (right[index] ?? 0))

describe("groupDigest", () => {
  it.effect("hashes the generator as a single octet", () =>
    Effect.gen(function*() {
      const expected = xor(
        yield* hash(fromBigInt(group.modulus)),
        yield* hash(Uint8Array.from([0x05]))
      )
      assert.deepStrictEqual(yield* groupDigest(group), expected)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("is not the padded variant", () =>
    Effect.gen(function*() {
      // The variant rejected by Apple's M1 vector, pinned so that "unifying"
      // this with the multiplier's encoding fails loudly here as well as in
      // M1.
      const padded = xor(
        yield* hash(Group.encode(group, group.modulus)),
        yield* hash(Group.encode(group, group.generator))
      )
      assert.notDeepEqual(yield* groupDigest(group), padded)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("is 64 octets, so it lines up with the other digests in M1", () =>
    Effect.gen(function*() {
      assert.strictEqual((yield* groupDigest(group)).length, 64)
    }).pipe(Effect.provide(NodeServices.layer)))
})
