// Writing a value that does not fit in one item.
//
// The length is one byte, so a value of more than 255 bytes is written as
// consecutive items of the *same type*: as many 255-byte fragments as it
// takes, then a final fragment holding what is left over.
//
// The final fragment is written even when what is left over is nothing, and
// that is the part that looks redundant and is not. A reader ends a run at the
// first fragment shorter than 255 bytes (see ./Join.ts), so a value of exactly
// 255 bytes written as one 255-byte item leaves the reader mid-run: it looks
// at the next item, and if that item happens to have the same type it merges
// the two. A list response repeats types on purpose — an Identifier and a
// Permissions item per pairing — so this is not a hypothetical: the reader
// would hand its caller one identifier made of two, and the caller would go on
// to sign it. The empty trailing fragment is what says "the value stopped
// here".

import { type Item, MAX_VALUE_LENGTH } from "../Item.ts"

/**
 * One item, as the fragments it is written as.
 *
 * **Details**
 *
 * Always returns at least one fragment, and every fragment it returns is at
 * most `MAX_VALUE_LENGTH` bytes — which is the precondition the payload writer
 * relies on, since it writes each fragment's length into a single byte without
 * checking. The last fragment is always shorter than `MAX_VALUE_LENGTH`, empty
 * if the value divided evenly.
 *
 * **Gotchas**
 *
 * A zero-length value is one empty fragment, not zero fragments. Dropping it
 * would lose the item entirely, and a missing item and an empty item mean
 * different things in pairing — `kTLVType_Separator` is defined as a
 * zero-length item and carries all of its meaning by being present.
 *
 * @example
 * ```ts
 * split({ type: 3, value: new Uint8Array(512) }).map((f) => f.value.length)
 * // => [255, 255, 2]
 *
 * split({ type: 3, value: new Uint8Array(255) }).map((f) => f.value.length)
 * // => [255, 0]   the empty fragment ends the run
 * ```
 *
 * @category encoding
 * @since 0.1.0
 */
export const split = (item: Item): ReadonlyArray<Item> =>
  Array.from(
    // One more fragment than there are whole 255-byte chunks. For a value that
    // divides evenly that extra fragment is empty, which is the terminator the
    // module comment above is about; for any other value it is the remainder.
    { length: Math.floor(item.value.length / MAX_VALUE_LENGTH) + 1 },
    (_, index): Item => ({
      type: item.type,
      // `slice`, not `subarray`: fragments outlive this call and a shared view
      // would keep the whole original value reachable and mutable from two
      // places at once.
      value: item.value.slice(index * MAX_VALUE_LENGTH, (index + 1) * MAX_VALUE_LENGTH)
    })
  )
