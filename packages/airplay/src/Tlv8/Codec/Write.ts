// Laying fragments out as bytes.
//
// The counterpart of ./Read.ts and the whole of it: type, length, value, for
// each item in turn. Everything that is interesting about writing TLV8 has
// already happened by the time control reaches here — it happened in
// ../Fragment/Split.ts — which is why this file is three lines and why it is
// still its own file rather than an expression buried in the codec.

import type { Item } from "../Item.ts"

/**
 * Fragments as the bytes of a payload.
 *
 * **Gotchas**
 *
 * Every item given here must already be a fragment: at most
 * `Item.MAX_VALUE_LENGTH` bytes of value. A longer one is not rejected, it is
 * silently mangled — `value.length` for a 300-byte value writes the length
 * byte `44` and the reader on the other side takes the next 256 bytes as
 * further items. That is why `./Items.ts` is the only caller and why it pipes
 * everything through `Fragment.split` first, unconditionally, including values
 * that would have fitted: a conditional split is a rule that has to be right
 * twice.
 *
 * @example
 * ```ts
 * write([{ type: 6, value: new Uint8Array([1]) }])
 * // => Uint8Array [6, 1, 1]
 * ```
 *
 * @category encoding
 * @since 0.1.0
 */
export const write = (fragments: ReadonlyArray<Item>): Uint8Array =>
  Uint8Array.from(
    fragments.flatMap((fragment) => [fragment.type, fragment.value.length, ...fragment.value])
  )
