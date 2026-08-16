// Splitting a list response into its entries.
//
// `kTLVType_Separator` is a zero-length item whose entire meaning is where it
// sits. `ListPairings` answers with an Identifier, a PublicKey and a
// Permissions item for every pairing the device knows, one after another with
// a separator between entries — so the repeated types are the structure of the
// response and the separator is the only thing that says where one entry ends.
//
// Without this, a caller has two bad options: ask for the first Identifier and
// see one pairing, or collect every Identifier and every Permissions
// separately and pair them up by position, which is right until a device omits
// an optional item from one entry and every permission after it belongs to the
// wrong pairing.

import { TlvType } from "../../Generated/index.ts"
import type { Item } from "../Item.ts"

/**
 * A payload's items, cut into groups at each separator.
 *
 * **Details**
 *
 * The separators themselves are dropped — they carry no value and every caller
 * would filter them out again. Empty groups are dropped too, which makes this
 * indifferent to a leading or trailing separator: writers differ on whether
 * the last entry is followed by one, and a caller that has to cope with a
 * final empty entry will cope with it by indexing, which is how a list gets
 * read off by one.
 *
 * A payload with no separator is one group, and an empty payload is no groups
 * — so `groups(items).length` is the number of entries in a list response
 * without a special case for "none".
 *
 * **Gotchas**
 *
 * Because empty groups are dropped, two adjacent separators are
 * indistinguishable from one. That is a deliberate trade: an empty entry is
 * not something the format can express — an entry is at least an identifier —
 * so there is nothing to lose and a malformed-but-harmless response to
 * tolerate.
 *
 * @example
 * ```ts
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * const separator = { type: GeneratedPairing.TlvType.Separator, value: new Uint8Array(0) }
 * groups([
 *   { type: 1, value: alice }, { type: 11, value: new Uint8Array([1]) },
 *   separator,
 *   { type: 1, value: bob }, { type: 11, value: new Uint8Array([0]) }
 * ]).length
 * // => 2
 * ```
 *
 * @category querying
 * @since 0.1.0
 */
export const groups = (
  items: ReadonlyArray<Item>
): ReadonlyArray<ReadonlyArray<Item>> => {
  // Expressed as cut points rather than as a fold that accumulates groups: the
  // separators *are* the boundaries, and the two sentinels turn "between
  // consecutive separators" into "before the first" and "after the last"
  // without either being a special case.
  const cuts = [
    -1,
    ...items.flatMap((item, index) => item.type === TlvType.Separator ? [index] : []),
    items.length
  ]
  return cuts
    .slice(0, -1)
    .map((start, index) => items.slice(start + 1, cuts[index + 1] ?? items.length))
    .filter((group) => group.length > 0)
}
