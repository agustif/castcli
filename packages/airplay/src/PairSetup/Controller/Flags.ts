/**
 * `kTLVType_Flags`: a 32-bit field written in as few bytes as it needs.
 *
 * The one item in pair-setup that is neither a fixed-width value nor an opaque
 * blob, and the only one with an encoding rule of its own. HAP writes it
 * little-endian with trailing zero bytes dropped, so the same number is a
 * different number of bytes depending on how large it is —
 * `kHAPPairingFlag_Transient` (0x10) is one byte and `kHAPPairingFlag_Split`
 * (0x01000000) is four — and a zero-valued field is written as no item at all.
 * `HAPPairingGetNumBytes` in `packages/airplay/vendor/HAPPairing.c` is that
 * rule; `HAPPairingReadFlags` beside it is the other direction.
 *
 * Both directions are stated here as one codec because the two are easy to get
 * separately wrong in ways nothing catches: a big-endian writer produces a flags
 * item an accessory reads as some other flag entirely — 0x10 written wide is
 * 0x10000000, which HAP logs as unrecognised and ignores — and a reader that
 * assumes four bytes reads past a one-byte item.
 *
 * @since 0.1.0
 */
import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect"

/** The field is 32 bits, so it is never more than four bytes on the wire. */
const WIDTH = 4

/**
 * The little-endian value of up to four bytes.
 *
 * Multiplication rather than `<<`. JavaScript's bitwise operators work on signed
 * 32-bit integers, so a flag in the top bit — which HAP has not defined yet, and
 * which is exactly the kind of thing a later specification adds — would come out
 * negative and compare equal to nothing.
 */
const read = (bytes: Uint8Array): number =>
  bytes.reduce((value, byte, index) => value + byte * 2 ** (8 * index), 0)

/**
 * How many bytes a value is written in: `HAPPairingGetNumBytes`, restated.
 *
 * Zero for zero, which is what makes "no flags" and "an item full of zeros"
 * the same thing — see {@link Flags} for why the caller must then omit the item.
 */
const width = (flags: number): number =>
  flags > 0xffffff ? 4 : flags > 0xffff ? 3 : flags > 0xff ? 2 : flags > 0 ? 1 : 0

/** The value as its minimal little-endian bytes. */
const write = (flags: number): Uint8Array =>
  Uint8Array.from(
    { length: width(flags) },
    (_, index) => Math.floor(flags / 2 ** (8 * index)) % 256
  )

/**
 * The pairing flags field: bytes on the wire, a 32-bit number in the program.
 *
 * **Details**
 *
 * Decoding rejects more than four bytes rather than reading the first four.
 * `HAPPairingPairSetupProcessM1` does the same — a longer flags item is
 * `kHAPError_InvalidData` and aborts the procedure — so accepting it here would
 * only mean disagreeing with the accessory about a message it has already
 * refused.
 *
 * **Gotchas**
 *
 * The round trip normalises rather than preserving: `[0x10, 0x00]` decodes to
 * 16 and encodes back to `[0x10]`. That is the specified encoding rather than a
 * lossy shortcut — a writer is required to drop the trailing zeros — but it does
 * mean this codec cannot be used to check that a peer's bytes were minimal.
 *
 * Zero encodes to an empty array, and an empty item is not the same as an absent
 * one: HAP's own writer skips the item entirely when the flags are zero, and a
 * caller of this codec has to do the same rather than writing an empty
 * `kTLVType_Flags`.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * const bytes = Schema.encodeEffect(Flags)(
 *   GeneratedPairing.PairingFlag.Transient | GeneratedPairing.PairingFlag.Split
 * )
 * // => Uint8Array [0x10, 0x00, 0x00, 0x01]
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const Flags = Schema.Uint8Array.pipe(
  Schema.decodeTo(
    // The bound is what makes the encoder honest. Without it a caller passing
    // 2 ** 33 would get four bytes holding the low half of it — a different set
    // of flags, silently — because `write` takes the value modulo 2^32 by
    // construction.
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffffff })),
    {
      decode: SchemaGetter.transformOrFail((bytes: Uint8Array) =>
        bytes.length <= WIDTH
          ? Effect.succeed(read(bytes))
          : Effect.fail(
            new SchemaIssue.InvalidValue(undefined, {
              message:
                `kTLVType_Flags is a 32-bit field, so at most ${WIDTH} bytes; got ${bytes.length}`
            })
          )
      ),
      encode: SchemaGetter.transform((flags: number) => write(flags))
    }
  )
)
