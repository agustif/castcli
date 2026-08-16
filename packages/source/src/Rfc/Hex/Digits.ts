// Columns of hexadecimal, as one string of digits.

import { Schema, SchemaGetter } from "effect"
import { linesOf } from "../Lines.ts"
import { Text } from "../Text.ts"
import { COLUMNS, HEX_LINE, WIDTH } from "./Columns.ts"

/**
 * Hex printed in columns, as one continuous string of digits.
 *
 * **Details**
 *
 * Only lines that are *entirely* columns of hex count. RFC 5054 prints its
 * moduli under a paragraph of prose, and prose contains hex-looking words —
 * `added`, `deface`, `bad` — so a reader that took every hex-shaped token would
 * splice English into a prime and produce a number that is wrong in a way no
 * length check would catch.
 *
 * Encoding lays the digits back out in the same columns, so a round trip over
 * a real RFC checks the layout rather than the length.
 *
 * **Gotchas**
 *
 * This takes every hex-only line in the text it is given, not the first block.
 * Narrowing is the caller's job, through `fromSection`. A section whose
 * subsection also prints a table would therefore yield both concatenated —
 * which is caught downstream, where the extracted number is checked for
 * primality rather than for length.
 *
 * @example
 * ```ts
 * import { Rfc } from "@castcli/source"
 *
 * const Digits = Rfc.fromSection("4.  3072-bit Group", Rfc.HexDigits)
 * ```
 *
 * @category codecs
 * @since 0.1.0
 */
export const HexDigits = Text.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.isPattern(/^[0-9A-Fa-f]*$/, { message: "expected hexadecimal digits" })
    ),
    {
      decode: SchemaGetter.transform((text: string) =>
        linesOf(text)
          .filter((line) => HEX_LINE.test(line))
          .flatMap((line) => line.trim().split(/\s+/))
          .join("")
      ),
      encode: SchemaGetter.transform((digits: string) => {
        const words = digits.match(new RegExp(`.{1,${WIDTH}}`, "g")) ?? []
        const rows = Array.from(
          { length: Math.ceil(words.length / COLUMNS) },
          (_, row) => `      ${words.slice(row * COLUMNS, (row + 1) * COLUMNS).join(" ")}`
        )
        return rows.join("\n")
      })
    }
  )
)
