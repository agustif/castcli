// One item of a TLV8 payload: a type byte, a length byte, and the value.
//
// The length is a single byte, which is the constraint the whole of this
// directory exists to work around: a value longer than 255 bytes does not fit
// in one item and is written as several (see ./Fragment/Split.ts). So `Item`
// deliberately puts no bound on `value`. An `Item` is the item a caller thinks
// in — the one that exists after fragments have been rejoined — and a 384-byte
// SRP public key is one `Item` here and two items on the wire.
//
// The type, by contrast, *is* bounded, and the bound is checked rather than
// assumed: see the schema below.

import { Schema } from "effect"

/**
 * One item of a TLV8 payload.
 *
 * **Details**
 *
 * `type` is a byte from the pairing vocabulary — `GeneratedPairing.TlvType`,
 * which is extracted from Apple's own header rather than transcribed here.
 * `value` is the item's payload of arbitrary length; the one-byte limit
 * belongs to the wire encoding, not to this type.
 *
 * @example
 * ```ts
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * const state: Item = {
 *   type: GeneratedPairing.TlvType.State,
 *   value: new Uint8Array([1])
 * }
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface Item {
  readonly type: number
  readonly value: Uint8Array
}

/**
 * The most a single item can carry, because the length is one byte.
 *
 * **When to use**
 *
 * As the fragment size when splitting a long value and as the "is this run
 * still going?" test when rejoining one. Both rules are stated in terms of
 * this exact number, and writing `255` in either place separately is how the
 * two halves drift apart.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_VALUE_LENGTH = 255

/**
 * {@link Item} as a schema, so an array of them can be the decoded side of the
 * payload codec.
 *
 * **Gotchas**
 *
 * The range check on `type` is not decoration. It cannot fail when decoding —
 * a byte read out of a `Uint8Array` is already 0..255 — but it is the only
 * thing standing between a caller with an out-of-range constant and a payload
 * that encodes silently and wrongly: writing `256` as a length-one byte gives
 * `0`, which is `kTLVType_Method`, so the device would answer a Method item it
 * was never sent instead of rejecting the message.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 *
 * const decode = Schema.decodeUnknownEffect(Schema.Array(Item))
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const Item = Schema.Struct({
  // 255 here is the largest value of a *type* byte, which is a different fact
  // that happens to share a number with MAX_VALUE_LENGTH above. Spelling it
  // out rather than reusing that constant keeps the two independent, so a
  // reader does not infer a relationship that is not there.
  type: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
  value: Schema.Uint8Array
})
