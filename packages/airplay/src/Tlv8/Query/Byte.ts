// Reading the one-byte items, and only the one-byte items.
//
// State, Method, Error and Permissions are each written as a single byte, and
// they are the items a pairing state machine branches on. Everything a wrong
// answer here causes happens later and elsewhere: a State read as 3 instead of
// 5 sends the next message of the wrong exchange, and the device replies with
// an authentication error that reads as a bad password.

import { Option } from "effect"
import type { Item } from "../Item.ts"
import { find } from "./Find.ts"

/**
 * The value of a one-byte item, as a number.
 *
 * **Details**
 *
 * Absent if the item is absent *or* if its value is not exactly one byte. The
 * length condition is the whole reason this exists rather than callers writing
 * `value[0]`: taking the first byte of whatever arrives turns a 64-byte proof
 * into a plausible small integer, and a state machine fed a plausible small
 * integer takes a real branch and fails somewhere else entirely.
 *
 * **Gotchas**
 *
 * `kTLVType_Flags` is deliberately *not* readable this way. HAP writes flags
 * as a little-endian integer of one to four bytes, dropping trailing zero
 * bytes, so a flags item is one byte often enough that a `byte`-based reader
 * would pass every test and then silently ignore the high flags of the one
 * device that sets them. Read those with a codec that knows the width.
 *
 * @example
 * ```ts
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * byte(items, GeneratedPairing.TlvType.State)  // => Option.some(3)
 * byte(items, GeneratedPairing.TlvType.Proof)  // => Option.none(), 64 bytes long
 * ```
 *
 * @category querying
 * @since 0.1.0
 */
export const byte = (
  items: ReadonlyArray<Item>,
  type: number
): Option.Option<number> =>
  Option.flatMap(find(items, type), (value) =>
    value.length === 1 ? Option.fromUndefinedOr(value[0]) : Option.none())
