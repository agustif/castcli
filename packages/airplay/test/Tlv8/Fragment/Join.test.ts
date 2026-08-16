// Rejoining, checked against the three ways the rule is usually written wrong.
//
// Each test below names the mutation it catches, because a test of a merging
// rule that only ever sees fragments that should merge passes against an
// implementation that merges everything.

import { assert, describe, it } from "@effect/vitest"
import { Crypto, Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { join } from "../../../src/Tlv8/Fragment/Join.ts"
import type { Item } from "../../../src/Tlv8/Item.ts"

const IDENTIFIER = 1
const PUBLIC_KEY = 3
const PERMISSIONS = 11

describe("Tlv8.Fragment.join", () => {
  it.effect("merges a run of adjacent fragments of the same type", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const value = yield* crypto.randomBytes(512)
      const joined = join([
        { type: PUBLIC_KEY, value: value.slice(0, 255) },
        { type: PUBLIC_KEY, value: value.slice(255, 510) },
        { type: PUBLIC_KEY, value: value.slice(510) }
      ])

      assert.strictEqual(joined.length, 1)
      assert.deepStrictEqual(
        Array.from(joined[0]?.value ?? new Uint8Array(0)),
        Array.from(value)
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it("ends a run at a fragment shorter than 255, even when it is empty", () => {
    // Catches: dropping the `open` condition, or writing it as
    // `item.value.length > 0`. Both merge the trailing item into the value,
    // giving one 260-byte identifier instead of a 255-byte one and a separate
    // 5-byte one.
    const items: ReadonlyArray<Item> = [
      { type: IDENTIFIER, value: new Uint8Array(255).fill(1) },
      { type: IDENTIFIER, value: new Uint8Array(0) },
      { type: IDENTIFIER, value: new Uint8Array(5).fill(2) }
    ]
    assert.deepStrictEqual(join(items).map((item) => item.value.length), [255, 5])
  })

  it("keeps two items of the same type that are not adjacent as two items", () => {
    // Catches: merging by type alone — "collect every item of this type and
    // concatenate", which is the implementation everyone writes first. Under
    // that mutation this returns two items (one identifier of 8 bytes and the
    // permissions) instead of three, and every list response loses its
    // entries.
    const items: ReadonlyArray<Item> = [
      { type: IDENTIFIER, value: new Uint8Array(4).fill(1) },
      { type: PERMISSIONS, value: new Uint8Array([1]) },
      { type: IDENTIFIER, value: new Uint8Array(4).fill(2) }
    ]
    const joined = join(items)
    assert.strictEqual(joined.length, 3)
    assert.deepStrictEqual(joined.map((item) => item.type), [IDENTIFIER, PERMISSIONS, IDENTIFIER])
  })

  it("keeps two adjacent short items of the same type as two items", () => {
    // Catches: dropping the length condition and merging any two adjacent
    // items that share a type. That is what a two-entry list looks like before
    // the separator is taken into account, so it is not an exotic input.
    const items: ReadonlyArray<Item> = [
      { type: IDENTIFIER, value: new Uint8Array(4).fill(1) },
      { type: IDENTIFIER, value: new Uint8Array(4).fill(2) }
    ]
    assert.strictEqual(join(items).length, 2)
  })

  it("leaves a payload with no runs in it alone", () => {
    const items: ReadonlyArray<Item> = [
      { type: 6, value: new Uint8Array([1]) },
      { type: 0, value: new Uint8Array([0]) }
    ]
    assert.deepStrictEqual(join(items), items)
  })

  it("returns a run that reaches the end of the payload as far as it goes", () => {
    // A 255-byte fragment with nothing after it is a malformed payload — the
    // terminator is missing — but the malformation is an absent item, which is
    // indistinguishable from a sender that stopped. What can be detected
    // exactly is rejected in Codec/Read.ts instead.
    const items: ReadonlyArray<Item> = [
      { type: PUBLIC_KEY, value: new Uint8Array(255) },
      { type: PUBLIC_KEY, value: new Uint8Array(255) }
    ]
    assert.deepStrictEqual(join(items).map((item) => item.value.length), [510])
  })
})
