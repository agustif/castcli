// Pulling one value out of a message by its type.
//
// HAP does not fix the order of items within a message — the ADK's readers
// take a set of expected types and match whatever arrives in whatever order —
// so a caller must ask by type, never by index. Indexing works against one
// device and breaks against the next.

import { Option } from "effect"
import type { Item } from "../Item.ts"

/**
 * The value of the first item of a given type, if the message has one.
 *
 * **Details**
 *
 * `Option` rather than a throw or a zero-length default, because absent and
 * empty are different in this format and the difference is load-bearing: an
 * absent `kTLVType_Error` means the step succeeded, while a present one of any
 * length means it did not.
 *
 * **Gotchas**
 *
 * "First" means first, and stops there. That is right for a pairing message,
 * where each type appears once, and wrong for a list response, where types
 * repeat by design — reach for `./Groups.ts` there and call this on each
 * group. Expect the items to have been through `Fragment.join` already, which
 * they have if they came out of `Tlv8.Items`; on raw fragments this returns
 * the first 255 bytes of a longer value and looks entirely successful.
 *
 * @example
 * ```ts
 * import { Option } from "effect"
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * const salt = find(items, GeneratedPairing.TlvType.Salt)
 * Option.isNone(salt) // the device did not send one
 * ```
 *
 * @category querying
 * @since 0.1.0
 */
export const find = (
  items: ReadonlyArray<Item>,
  type: number
): Option.Option<Uint8Array> =>
  Option.map(
    Option.fromUndefinedOr(items.find((item) => item.type === type)),
    (item) => item.value
  )
