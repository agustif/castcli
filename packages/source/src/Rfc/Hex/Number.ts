// The same digits, as arithmetic.

import { Effect, Schema, SchemaGetter } from "effect"
import { invalid } from "../../Failure.ts"
import { HexDigits } from "./Digits.ts"

/**
 * The digits of {@link HexDigits} as a number, which is what a modulus is for.
 *
 * **Details**
 *
 * `BigInt` rather than `Uint8Array`: these values are arithmetic — modular
 * exponentiation in SRP — and a caller that wants bytes can encode them, while
 * a caller handed bytes has to reassemble the number and can get the endianness
 * wrong on the way.
 *
 * **Gotchas**
 *
 * A section with no hex at all fails here rather than decoding to `0n`. Zero is
 * a plausible-looking modulus and every subsequent operation on it succeeds,
 * which is precisely the silent outcome this package exists to prevent.
 *
 * @example
 * ```ts
 * import { Rfc } from "@castcli/source"
 *
 * const Modulus = Rfc.fromSection("4.  3072-bit Group", Rfc.BigIntFromHexDigits)
 * ```
 *
 * @category codecs
 * @since 0.1.0
 */
export const BigIntFromHexDigits = HexDigits.pipe(
  Schema.decodeTo(
    Schema.BigInt,
    {
      decode: SchemaGetter.transformOrFail((digits: string) =>
        digits.length === 0
          ? invalid("no hexadecimal digits in this section")
          : Effect.succeed(BigInt(`0x${digits}`))
      ),
      encode: SchemaGetter.transform((value: bigint) => {
        const digits = value.toString(16).toUpperCase()
        // Padded to whole bytes. An odd digit count is not wrong arithmetically
        // but it is not how the RFC prints it, and it would break the column
        // layout on the way back out.
        return digits.length % 2 === 0 ? digits : `0${digits}`
      })
    }
  )
)
