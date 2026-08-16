// The module's contract: what a caller outside this directory can reach.
//
// Worth asserting rather than assuming, because the barrel is the only place
// that says which of these files are private. `read`, `write`, `split` and
// `join` are each individually usable and individually a way to get the format
// wrong — using any of them alone skips one of the two rules — so their
// absence from here is a decision, and a decision is worth a test.

import { assert, describe, it } from "@effect/vitest"
import * as Tlv8 from "../../src/Tlv8/index.ts"

describe("Tlv8", () => {
  it("exports the payload codec, the item, and the three queries", () => {
    assert.isDefined(Tlv8.Items)
    assert.isDefined(Tlv8.Item)
    assert.isDefined(Tlv8.MAX_VALUE_LENGTH)
    assert.isFunction(Tlv8.find)
    assert.isFunction(Tlv8.byte)
    assert.isFunction(Tlv8.groups)
  })

  it("keeps the half-formats private", () => {
    const surface = Object.keys(Tlv8)
    assert.deepStrictEqual(
      surface.filter((name) => ["read", "write", "split", "join"].includes(name)),
      [],
      "a rule that must be applied with another one is reachable on its own"
    )
  })
})
