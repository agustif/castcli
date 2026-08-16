// M2, against Apple's.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SrpVectors } from "../../../src/Generated/index.ts"
import * as Group from "../../../src/Srp/Group.ts"
import { toBigInt } from "../../../src/Srp/Math/index.ts"
import { m2 } from "../../../src/Srp/Proof/M2.ts"

const group = Group.rfc5054

const exchange = {
  clientPublic: toBigInt(SrpVectors.A),
  m1: SrpVectors.m1,
  sessionKey: SrpVectors.k
}

describe("m2", () => {
  it.effect("reproduces Apple's M2", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* m2(group, exchange), SrpVectors.m2)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("depends on the M1 it answers", () =>
    Effect.gen(function*() {
      // This is what makes M2 a reply rather than a value the accessory could
      // have precomputed and sent to anybody.
      const other = yield* m2(group, { ...exchange, m1: new Uint8Array(64) })
      assert.notDeepEqual(other, SrpVectors.m2)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("depends on the session key, which is the part only the verifier gives", () =>
    Effect.gen(function*() {
      // Without K in it, M2 would be computable by anyone who saw A and M1 go
      // past — which is everyone on the network.
      const other = yield* m2(group, { ...exchange, sessionKey: new Uint8Array(64) })
      assert.notDeepEqual(other, SrpVectors.m2)
    }).pipe(Effect.provide(NodeServices.layer)))
})
