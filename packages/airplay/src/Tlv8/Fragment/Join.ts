// Rejoining a value that arrived as several items.
//
// The rule, in full: two items merge when they are **adjacent** and share a
// type **and** the earlier one is exactly 255 bytes long. All three conditions
// carry weight, and the implementation that gets written first usually has
// only the second.
//
// Dropping adjacency — "collect every item of this type and concatenate" — is
// the common mistake, and it corrupts every list response. `ListPairings`
// answers with an Identifier and a Permissions item per pairing, separated by
// `kTLVType_Separator`; the repeated types are the structure of the response,
// not fragments of one value. A reader that merges by type alone returns one
// identifier that is every identifier glued together, and every pairing after
// the first disappears.
//
// Dropping the length condition is subtler and shows up later: it merges two
// genuinely separate adjacent items whenever they share a type, which is
// exactly what a two-entry list looks like before the separator is considered.
//
// A run that reaches the end of the payload while still open — a 255-byte
// final fragment with nothing after it — is returned as it stands rather than
// rejected. The payload is malformed, but the malformation is a *missing*
// item, and there is nothing here to distinguish it from a writer that simply
// stopped; the truncation that can be detected exactly, a length byte
// promising bytes that are not there, is rejected in ../Codec/Read.ts.

import { type Item, MAX_VALUE_LENGTH } from "../Item.ts"

/** Two values, end to end. `Uint8Array` has no concat of its own. */
const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.length + right.length)
  joined.set(left)
  joined.set(right, left.length)
  return joined
}

/**
 * Items as read off the wire, with fragment runs merged back into whole items.
 *
 * `open` is the fold's whole state: whether the item just placed was a full
 * 255-byte fragment, and so whether the next item of the same type continues
 * it. Anything shorter closes the run, which is why a writer emits an empty
 * fragment after a value whose length is a multiple of 255.
 */
interface Run {
  readonly items: ReadonlyArray<Item>
  readonly open: boolean
}

/**
 * Rejoin adjacent fragments of the same type.
 *
 * **When to use**
 *
 * On everything read off the wire, before anything looks at it — which is what
 * the payload codec does, so callers of `Tlv8.Items` never see a fragment.
 * Reach for it directly only when reading items some other way.
 *
 * **Gotchas**
 *
 * Items of the same type that are *not* adjacent stay separate, and that is
 * the point rather than an omission. If you find yourself wanting the values
 * of every item of one type, you want a list, and the list is delimited by
 * `kTLVType_Separator` — see `../Query/Groups.ts`.
 *
 * @example
 * ```ts
 * // A 512-byte public key, as three items on the wire.
 * join([
 *   { type: 3, value: new Uint8Array(255) },
 *   { type: 3, value: new Uint8Array(255) },
 *   { type: 3, value: new Uint8Array(2) }
 * ]).map((item) => item.value.length)
 * // => [512]
 *
 * // Two identifiers with something between them: not one identifier.
 * join([
 *   { type: 1, value: new Uint8Array(4) },
 *   { type: 11, value: new Uint8Array(1) },
 *   { type: 1, value: new Uint8Array(4) }
 * ]).length
 * // => 3
 * ```
 *
 * @category decoding
 * @since 0.1.0
 */
export const join = (items: ReadonlyArray<Item>): ReadonlyArray<Item> =>
  items.reduce<Run>(
    (run, item) => {
      const previous = run.items.at(-1)
      return {
        items: run.open && previous !== undefined && previous.type === item.type
          ? [
            ...run.items.slice(0, -1),
            { type: item.type, value: concat(previous.value, item.value) }
          ]
          : [...run.items, item],
        // Read off *this* fragment, not the merged value: a 512-byte value
        // ends in a 2-byte fragment and must not stay open, while a run that
        // is still going ends in a 255-byte one and must.
        open: item.value.length === MAX_VALUE_LENGTH
      }
    },
    { items: [], open: false }
  ).items
