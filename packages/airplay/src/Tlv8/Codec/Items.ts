// A TLV8 payload as a Schema codec, in both directions.
//
// The four rules of the format live in four other files; this one is the wiring
// that guarantees they are always applied together and in the right order.
// Decoding is read-then-join, encoding is split-then-write, and neither half is
// reachable without the other — which matters because the two failures this
// format actually produces both come from doing half of it. A reader that skips
// `join` returns fragments and the caller treats the first 255 bytes as the
// whole key. A writer that skips `split` emits a length byte that is the low
// byte of the real length, and the device answers with an error nobody can look
// up.
//
// Expressing it as a codec rather than a pair of functions is the same move as
// everywhere else in this repo: encoding is the only real check that decoding
// understood the layout, and a round-trip test is only possible if both
// directions are one declaration.

import { Effect, Schema, SchemaGetter } from "effect"
import { Item } from "../Item.ts"
import { join } from "../Fragment/Join.ts"
import { split } from "../Fragment/Split.ts"
import { read } from "./Read.ts"
import { write } from "./Write.ts"

/**
 * A TLV8 payload: bytes on the encoded side, whole items on the decoded side.
 *
 * **Details**
 *
 * Decoding rejoins fragment runs, so an item's `value` is the value the sender
 * meant however many items it took to write. Encoding re-fragments, so a
 * decoded payload encodes back to the same bytes — including the empty
 * terminating fragment after a value whose length is a multiple of 255, which
 * a sender that omits it will find a receiver rejoins wrongly.
 *
 * Decoding fails on a payload that ends mid-item; see `./Read.ts` for why that
 * is worth failing on rather than salvaging.
 *
 * **When to use**
 *
 * For every pairing message in both directions. Items are ordered as written,
 * so use `Query.find` and `Query.byte` to pull values out rather than indexing
 * — HAP does not fix the order of items within a message.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * const exchange = Effect.gen(function*() {
 *   const m1 = yield* Schema.encodeEffect(Items)([
 *     { type: GeneratedPairing.TlvType.State, value: new Uint8Array([1]) },
 *     { type: GeneratedPairing.TlvType.Method, value: new Uint8Array([0]) }
 *   ])
 *   // m1 is Uint8Array [6, 1, 1, 0, 1, 0]
 *   return yield* Schema.decodeUnknownEffect(Items)(m1)
 *   // => [{ type: 6, value: [1] }, { type: 0, value: [0] }]
 * })
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const Items = Schema.Uint8Array.pipe(
  Schema.decodeTo(Schema.Array(Item), {
    decode: SchemaGetter.transformOrFail((bytes: Uint8Array) => Effect.map(read(bytes), join)),
    // `split` is applied to every item, not only the long ones. See
    // ./Write.ts: making it conditional would put the 255-byte boundary in two
    // places, and a value of exactly 255 bytes — which does fit — is precisely
    // the one that must still be written as two fragments.
    encode: SchemaGetter.transform((items: ReadonlyArray<Item>) => write(items.flatMap(split)))
  })
)
