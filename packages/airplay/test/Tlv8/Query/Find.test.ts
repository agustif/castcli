// Asking by type, and what "the first one" means.

import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { TlvType } from "../../../src/Generated/index.ts"
import { find } from "../../../src/Tlv8/Query/Find.ts"
import type { Item } from "../../../src/Tlv8/Item.ts"

const items: ReadonlyArray<Item> = [
  { type: TlvType.State, value: new Uint8Array([3]) },
  { type: TlvType.Salt, value: new Uint8Array(16).fill(9) },
  { type: TlvType.Identifier, value: new Uint8Array([1]) },
  { type: TlvType.Permissions, value: new Uint8Array([1]) },
  { type: TlvType.Identifier, value: new Uint8Array([2]) }
]

describe("Tlv8.find", () => {
  it("returns the value of the item with that type, whatever its position", () => {
    // Order within a message is not fixed by HAP, which is why nothing here
    // may index.
    assert.deepStrictEqual(
      Option.map(find(items, TlvType.Salt), (value) => value.length),
      Option.some(16)
    )
  })

  it("returns none for a type the message does not carry", () => {
    // Absent and empty are different: an absent Error means the step
    // succeeded, and a zero-length one means it did not.
    assert.isTrue(Option.isNone(find(items, TlvType.Error)))
  })

  it("distinguishes an empty value from an absent one", () => {
    const separator = [{ type: TlvType.Separator, value: new Uint8Array(0) }]
    assert.deepStrictEqual(
      Option.map(find(separator, TlvType.Separator), (value) => value.length),
      Option.some(0)
    )
  })

  it("returns the first of a repeated type and stops there", () => {
    assert.deepStrictEqual(
      Option.map(find(items, TlvType.Identifier), (value) => Array.from(value)),
      Option.some([1])
    )
  })
})
