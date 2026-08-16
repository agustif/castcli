// Reading the small numbers, and refusing to read one out of something large.

import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { TlvType } from "../../../src/Generated/index.ts"
import { byte } from "../../../src/Tlv8/Query/Byte.ts"
import type { Item } from "../../../src/Tlv8/Item.ts"

const items: ReadonlyArray<Item> = [
  { type: TlvType.State, value: new Uint8Array([3]) },
  { type: TlvType.Proof, value: new Uint8Array(64).fill(5) },
  { type: TlvType.Method, value: new Uint8Array(0) }
]

describe("Tlv8.byte", () => {
  it("reads a one-byte item as a number", () => {
    assert.deepStrictEqual(byte(items, TlvType.State), Option.some(3))
  })

  it("returns none for an item that is not one byte long", () => {
    // Catches: reading `value[0]` and ignoring the length. A 64-byte proof
    // would read as 5 here — a plausible State value — and the state machine
    // would take a real branch and fail somewhere with no connection to this.
    assert.isTrue(Option.isNone(byte(items, TlvType.Proof)), "read a byte out of a 64-byte proof")
    assert.isTrue(Option.isNone(byte(items, TlvType.Method)), "read a byte out of an empty item")
  })

  it("returns none for an absent item", () => {
    assert.isTrue(Option.isNone(byte(items, TlvType.Error)))
  })

  it("reads zero as zero rather than as absent", () => {
    // kTLVType_Error is only ever present when something went wrong, and
    // several of the useful values are small; a `value[0] || none` shortcut
    // would turn the byte 0 into "no item".
    assert.deepStrictEqual(
      byte([{ type: TlvType.Error, value: new Uint8Array([0]) }], TlvType.Error),
      Option.some(0)
    )
  })
})
