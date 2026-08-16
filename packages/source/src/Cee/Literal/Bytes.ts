// A named C byte array, as a codec.

import { Effect, Encoding, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { invalid } from "../../Failure.ts"
import { withoutComments } from "../Comment.ts"
import { valueOf } from "../Enum/Expression.ts"
import { Text as CeeText } from "../Source.ts"
import { assignmentTo, STRING } from "./Declaration.ts"

/**
 * A declaration whose value is a braced initialiser.
 *
 * `[^}]*` rather than anything balanced, and that is a real limit: this reads a
 * flat array of scalars and would take the first inner `}` of a nested
 * initialiser as the end. Every vector these are used for is flat, and the
 * alternative — matching balanced braces — cannot be done with a regular
 * expression at all, so the honest version is a stated limitation plus a
 * per-element check strict enough that a truncated read fails rather than
 * returning a short array.
 *
 * Nothing here worries about line breaks or comments inside the braces: the
 * source has its comments blanked before this runs, and `[^}]` spans newlines.
 */
const declarations = (identifier: string): RegExp =>
  new RegExp(`${assignmentTo(identifier)}\\{([^}]*)\\}`, "g")

/** The same identifier, declared as a string literal instead. */
const quoted = (identifier: string): RegExp =>
  new RegExp(`${assignmentTo(identifier)}${STRING}`, "g")

/**
 * The elements of one initialiser, each evaluated as a constant expression and
 * required to be a byte.
 *
 * Going through the same evaluator the enums use means `{ 1 << 4, 'A' + 1 }`
 * is not a special case — and, more importantly, that an element this reader
 * cannot evaluate stops the decode. Returning a shorter array would be the
 * quiet failure: a key derived from 15 bytes of a 16-byte salt is simply a
 * different key, and nothing between here and the device reports why.
 */
const bytesIn = (
  identifier: string,
  body: string
): Effect.Effect<Uint8Array, SchemaIssue.Issue> =>
  Effect.forEach(
    body.split(",").map((element) => element.trim()).filter((element) => element !== ""),
    (element) =>
      Option.match(valueOf(element), {
        onNone: () =>
          invalid(
            `"${identifier}" contains the element "${element}", which is not a constant ` +
              `expression this reader can evaluate`
          ),
        onSome: (value) =>
          Number.isInteger(value) && value >= 0 && value <= 255
            ? Effect.succeed(value)
            : invalid(
              `"${identifier}" contains the element "${element}", which is ${value} and ` +
                `so does not fit in a byte`
            )
      })
  ).pipe(Effect.map((values) => Uint8Array.from(values)))

const arrayIn = (identifier: string) =>
(source: string): Effect.Effect<Uint8Array, SchemaIssue.Issue> => {
  const code = withoutComments(source)
  const bodies = [...code.matchAll(declarations(identifier))].map((match) => match[1] ?? "")
  const first = bodies[0]
  return first === undefined
    ? invalid(
      quoted(identifier).test(code)
        ? `"${identifier}" is declared in this C source as a string literal, ` +
          `not a byte array — read it with stringLiteral`
        : `no byte array named "${identifier}" in this C source`
    )
    : Effect.forEach(bodies, (body) => bytesIn(identifier, body)).pipe(
      Effect.flatMap((found) => {
        // Distinct by content, for the same reason `stringLiteral` is: a name
        // declared twice with the same bytes is the ordinary preprocessor-guard
        // case, but a name declared twice with different bytes has no single
        // value, and picking one would be a guess dressed as a result.
        const distinct = Array.from(new Set(found.map((bytes) => Encoding.encodeHex(bytes))))
        return distinct.length > 1
          ? invalid(
            `"${identifier}" is declared ${distinct.length} times with different contents ` +
              `in this C source; it is a name reused per scope, so there is no single ` +
              `value to read`
          )
          : Effect.succeed(found[0] ?? Uint8Array.from([]))
      })
    )
}

/**
 * Twelve to a line, which is roughly how a formatter lays these out and short
 * enough that a diff of a changed vector points at the byte rather than at the
 * file.
 */
const PER_LINE = 12

const rendered = (identifier: string) => (bytes: Uint8Array): string => {
  const words = Array.from(bytes, (byte) => `0x${byte.toString(16).padStart(2, "0")}`)
  const rows = Array.from(
    { length: Math.ceil(words.length / PER_LINE) },
    (_, row) => `    ${words.slice(row * PER_LINE, (row + 1) * PER_LINE).join(", ")},`
  )
  return `static const uint8_t ${identifier}[] = {\n${rows.join("\n")}\n};`
}

/**
 * The bytes of a named C array.
 *
 * **Details**
 *
 * Reads `static const uint8_t srp_salt[] = { 0xBE, 0xB2, … };`, tolerating
 * comments and line breaks inside the braces, a trailing comma, and elements
 * written as any constant expression rather than as hexadecimal literals.
 *
 * **When to use**
 *
 * For test vectors and fixed key material — the things that are hundreds of
 * bytes long and where a single transposed digit produces a test that fails for
 * a reason nobody can find. Apple's SRP vectors are the case in hand: their
 * published vectors stop at the session key, so the proofs in their test file
 * are the only public way to check the part most likely to be wrong.
 *
 * **Gotchas**
 *
 * Flat arrays only — a nested initialiser is read as far as its first inner
 * `}`, which will normally then fail on an unevaluable element rather than
 * returning a truncated array, but is not guaranteed to.
 *
 * Encoding writes the array back out in the canonical shape, not the source's:
 * lowercase hexadecimal, twelve to a line. A round trip therefore checks the
 * bytes, which is what matters, and not the formatting, which does not.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Cee } from "@castcli/source"
 *
 * const source = `static const uint8_t srp_salt[] = { 0xBE, 0xB2 };`
 * const salt = Schema.decodeUnknownEffect(Cee.byteArray("srp_salt"))(source)
 * // => Uint8Array [ 190, 178 ]
 * ```
 *
 * @category codecs
 * @since 0.1.0
 */
export const byteArray = (identifier: string) =>
  CeeText.pipe(
    Schema.decodeTo(Schema.Uint8Array, {
      decode: SchemaGetter.transformOrFail(arrayIn(identifier)),
      encode: SchemaGetter.transform(rendered(identifier))
    })
  )
