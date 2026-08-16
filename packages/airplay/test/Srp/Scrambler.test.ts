// u, against Apple's published value.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SrpVectors } from "../../src/Generated/index.ts"
import * as Group from "../../src/Srp/Group.ts"
import { toBigInt } from "../../src/Srp/Math/index.ts"
import { scrambler } from "../../src/Srp/Scrambler.ts"

const group = Group.rfc5054

describe("scrambler", () => {
  it.effect("reproduces Apple's u from A and B", () =>
    Effect.gen(function*() {
      const u = yield* scrambler(group, toBigInt(SrpVectors.A), toBigInt(SrpVectors.B))
      assert.strictEqual(u, toBigInt(SrpVectors.u))
    }).pipe(Effect.provide(NodeServices.layer)))

  it("is the full digest, not truncated to 32 bits", () => {
    // SRP-3 truncated `u`; SRP-6a does not, and `SRP_SCRAMBLING_PARAMETER_BYTES`
    // in HAPCrypto.h is 64. A truncating implementation would still agree with
    // itself on both sides of an exchange and disagree with every accessory,
    // so this is asserted about the published value rather than about ours.
    assert.strictEqual(SrpVectors.u.length, 64)
    assert.isTrue(toBigInt(SrpVectors.u) > 2n ** 32n, "u fits in 32 bits — it was truncated")
  })

  it.effect("depends on both public values", () =>
    Effect.gen(function*() {
      // If it did not, one side could fix `u` in advance. The concrete failure
      // is `u = 0`, which drops the verifier out of the server's derivation
      // entirely.
      const A = toBigInt(SrpVectors.A)
      const B = toBigInt(SrpVectors.B)
      assert.notStrictEqual(yield* scrambler(group, A, B), yield* scrambler(group, B, A))
    }).pipe(Effect.provide(NodeServices.layer)))
})
