// Values an RFC states in a sentence rather than in a table.

import { Effect, Schema, SchemaTransformation } from "effect"
import { invalid } from "../../Failure.ts"
import { linesOf } from "../Lines.ts"
import { Text } from "../Text.ts"

/**
 * A value stated in prose: `The generator is: 5.`
 *
 * **Details**
 *
 * RFCs give the small constants in a sentence rather than a table, and the
 * sentence is stable across revisions in a way line numbers are not. The label
 * is matched literally and the rest of the line up to a full stop is handed to
 * the given schema, so the caller says what kind of value it is.
 *
 * **Gotchas**
 *
 * The first line *containing* the label wins, and only the remainder of that
 * one line is read. A value that wraps onto the next line is therefore
 * truncated rather than rejected — the schema the caller supplies is what
 * catches that, which is a reason to pass `Schema.FiniteFromString` rather than
 * `Schema.String` whenever the value has a shape.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Rfc } from "@castcli/source"
 *
 * const Generator = Rfc.fromSection(
 *   "4.  3072-bit Group",
 *   Rfc.labelled("The generator is:", Schema.FiniteFromString)
 * )
 * ```
 *
 * @category codecs
 * @since 0.1.0
 */
export const labelled = <S extends Schema.ConstraintCodec<unknown, string, unknown, unknown>>(
  label: string,
  schema: S
) =>
  Text.pipe(
    Schema.decodeTo(
      schema,
      SchemaTransformation.transformOrFail({
        decode: (text: string) => {
          const line = linesOf(text).find((candidate) => candidate.includes(label))
          const value = line?.slice((line.indexOf(label) ?? 0) + label.length).trim()
          return value === undefined || value.length === 0
            ? invalid(`no line saying "${label}" in this document`)
            : Effect.succeed(value.replace(/\.$/, "").trim())
        },
        encode: (value: string) => Effect.succeed(`   ${label} ${value}.`)
      })
    )
  )
