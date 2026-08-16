// Cutting a list response into its entries.
//
// The fixture is a `ListPairings` response with two pairings in it, which is
// the shape that makes every wrong answer visible: with one pairing, "split on
// the separator" and "return everything as one group" agree.

import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { TlvType } from "../../../src/Generated/index.ts"
import { find } from "../../../src/Tlv8/Query/Find.ts"
import { groups } from "../../../src/Tlv8/Query/Groups.ts"
import type { Item } from "../../../src/Tlv8/Item.ts"

const separator: Item = { type: TlvType.Separator, value: new Uint8Array(0) }

const entry = (identifier: number, permissions: number): ReadonlyArray<Item> => [
  { type: TlvType.Identifier, value: new Uint8Array([identifier]) },
  { type: TlvType.PublicKey, value: new Uint8Array(32).fill(identifier) },
  { type: TlvType.Permissions, value: new Uint8Array([permissions]) }
]

const listPairings: ReadonlyArray<Item> = [...entry(1, 1), separator, ...entry(2, 0)]

describe("Tlv8.groups", () => {
  it("splits a list response into one group per entry", () => {
    // Catches: not splitting at all, and splitting on something other than the
    // separator. Under either, `find` below reads the first entry's identifier
    // for both pairings, and the second pairing's permissions are attributed
    // to the first.
    const entries = groups(listPairings)
    assert.strictEqual(entries.length, 2)
    assert.deepStrictEqual(
      entries.map((group) =>
        Option.map(find(group, TlvType.Identifier), (value) => value[0])
      ),
      [Option.some(1), Option.some(2)]
    )
    assert.deepStrictEqual(
      entries.map((group) => Option.map(find(group, TlvType.Permissions), (value) => value[0])),
      [Option.some(1), Option.some(0)]
    )
  })

  it("drops the separators themselves", () => {
    // Catches: cutting in the right places but leaving the separator at the
    // head of the next group, where it sorts before the identifier and any
    // caller reading positionally picks it up as one.
    assert.isTrue(
      groups(listPairings).every((group) =>
        group.every((item) => item.type !== TlvType.Separator)
      ),
      "a separator survived into a group"
    )
  })

  it("returns one group for a message with no separator in it", () => {
    // A pairing message is a list of one as far as this is concerned, so a
    // caller does not need to know which kind of response it has.
    assert.strictEqual(groups(entry(1, 1)).length, 1)
  })

  it("returns no groups for an empty payload", () => {
    // So `groups(items).length` is the number of entries, with no special
    // case for "the device knows about no pairings".
    assert.deepStrictEqual(groups([]), [])
  })

  it("is indifferent to a trailing separator", () => {
    // Writers differ on whether the last entry gets one. A caller that has to
    // cope with a final empty group copes by indexing, which is how a list
    // gets read off by one.
    assert.strictEqual(groups([...listPairings, separator]).length, 2)
    assert.strictEqual(groups([separator, ...listPairings]).length, 2)
  })
})
