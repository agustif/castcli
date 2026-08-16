// Addressing a section of an RFC as if it were a field of a record.

import { Effect, Schema, SchemaTransformation } from "effect"
import { invalid } from "../../Failure.ts"
import { Text } from "../Text.ts"
import { bodyOf } from "./Body.ts"

/**
 * The body of one section, addressed by its heading exactly as printed.
 *
 * **Details**
 *
 * The heading is matched literally, double spaces included, because that is
 * what the RFC contains and a normalising match would quietly accept a heading
 * from a different revision. A heading that is absent fails; it does not return
 * empty.
 *
 * **When to use**
 *
 * Rarely on its own — `fromSection` is the composed form callers want. This is
 * exported because a caller with its own `from` schema, or one that wants the
 * section text unparsed, needs the transformation rather than the codec.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Rfc } from "@castcli/source"
 *
 * const Body = Rfc.Text.pipe(Schema.decodeTo(Schema.String, Rfc.section("4.  3072-bit Group")))
 * ```
 *
 * @category transformations
 * @since 0.1.0
 */
export const section = (heading: string): SchemaTransformation.Transformation<string, string> =>
  SchemaTransformation.transformOrFail({
    decode: (text: string) => {
      const body = bodyOf(text, heading)
      return body.length === 0
        ? invalid(`no section "${heading}" in this document`)
        : Effect.succeed(body.join("\n"))
    },
    // Back under its own heading. Not a byte-for-byte reconstruction of the
    // original file — the rest of the RFC is gone — but enough that a decode of
    // an encode returns the same section, which is the property worth having.
    encode: (body: string) => Effect.succeed(`${heading}\n${body}`)
  })

/**
 * A schema decoded from the text of an RFC, the way `fromJsonString` decodes
 * one from JSON.
 *
 * **Details**
 *
 * The section is cut out first and the given schema decodes what is inside it,
 * so the caller says *where* and *what kind* separately. Narrowing to a section
 * is how a reader is kept from wandering: `HexDigits` takes every column of hex
 * in the text it is given, and the section is what makes that a definite
 * quantity.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Rfc } from "@castcli/source"
 *
 * const Modulus = Rfc.fromSection("4.  3072-bit Group", Rfc.BigIntFromHexDigits)
 * const read = Schema.decodeUnknownEffect(Modulus)
 * ```
 *
 * @category codecs
 * @since 0.1.0
 */
export const fromSection = <S extends Schema.ConstraintCodec<unknown, string, unknown, unknown>>(
  heading: string,
  schema: S
) => Text.pipe(Schema.decodeTo(schema, section(heading)))
