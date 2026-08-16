// Reading items out of a payload, and refusing to guess when it is short.
//
// The format offers no way to check itself: there is no total length, no
// checksum and no terminator, so a payload that has been truncated in transit
// looks exactly like a payload that ended. The one thing that does not look
// like a valid ending is a length byte promising more bytes than remain, and
// that is what this rejects.
//
// It has to reject it rather than return what it has. A pairing message that
// loses its tail loses the item that would have failed to verify — the Proof,
// the Signature — and everything before it decodes perfectly. Returning the
// prefix hands the caller a message that is missing exactly the part that
// would have said no.

import { Effect, SchemaIssue } from "effect"
import type { Item } from "../Item.ts"

/** A type byte and a length byte precede every value. */
const HEADER = 2

/**
 * The items in a payload, exactly as written — fragments still separate.
 *
 * **Details**
 *
 * Reads until the bytes run out, and fails if they run out mid-item. Fragment
 * runs are left alone: rejoining them is `Fragment.join`'s rule, and keeping
 * the two apart means the reader has no opinion about which repeated types are
 * one value and which are a list.
 *
 * **Gotchas**
 *
 * Every value is copied out of the payload rather than viewed into it. A
 * `subarray` would be cheaper and would keep the whole message alive for as
 * long as any one item is held, and — worse — would let a later write to the
 * payload change a value already handed to a caller, which for a nonce or a
 * key is a bug that surfaces as a decryption failure a long way from here.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 *
 * // 06 01 01 — a one-byte State item.
 * const items = Effect.gen(function*() {
 *   return yield* read(new Uint8Array([6, 1, 1]))
 *   // => [{ type: 6, value: Uint8Array [1] }]
 * })
 * ```
 *
 * @category decoding
 * @since 0.1.0
 */
export const read = (
  bytes: Uint8Array
): Effect.Effect<ReadonlyArray<Item>, SchemaIssue.Issue> => {
  let offset = 0
  // Appended to in place rather than rebuilt each step: a payload is up to
  // 64KiB and its items are two bytes each, so a fold that spreads the
  // accumulator is quadratic in a number that a peer chooses. It never leaves
  // this function except as a ReadonlyArray.
  const items: Array<Item> = []
  // Stops on the first item that does not fit — either because there is no
  // room for a header or because the length byte overruns the end — leaving
  // `offset` short of the end, which is how the check below tells a clean
  // ending from a truncated one.
  while (
    offset + HEADER <= bytes.length &&
    offset + HEADER + (bytes[offset + 1] ?? 0) <= bytes.length
  ) {
    const length = bytes[offset + 1] ?? 0
    items.push({
      type: bytes[offset] ?? 0,
      value: bytes.slice(offset + HEADER, offset + HEADER + length)
    })
    offset = offset + HEADER + length
  }
  const remaining = bytes.length - offset
  return remaining === 0
    ? Effect.succeed(items)
    : Effect.fail(
      new SchemaIssue.InvalidValue(undefined, {
        message: remaining < HEADER
          ? `truncated TLV8 payload: a type byte at offset ${offset} with no length byte after it`
          : `truncated TLV8 payload: the item at offset ${offset} claims ${
            bytes[offset + 1] ?? 0
          } bytes of value but only ${remaining - HEADER} remain`
      })
    )
}
