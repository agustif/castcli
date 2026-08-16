// A named string constant, as a codec.

import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect"
import { invalid } from "../../Failure.ts"
import { withoutComments } from "../Comment.ts"
import { Text as CeeText } from "../Source.ts"
import { assignmentTo, STRING } from "./Declaration.ts"
import { escape, unescape } from "./Escape.ts"

/**
 * A declaration whose value is one or more string literals.
 *
 * The `(?:…\s*)+` accepts adjacent literals: C concatenates
 * `"Pair-Setup-" "Encrypt-Salt"` into one string, and a reader taking only the
 * first would return a salt that is a prefix of the real one — the worst
 * possible failure for key material, because it is the right shape and the
 * right kind of characters.
 */
const declarations = (identifier: string): RegExp =>
  new RegExp(`${assignmentTo(identifier)}((?:${STRING}\\s*)+)`, "g")

/** The same identifier, declared with a braced initialiser instead. */
const braced = (identifier: string): RegExp =>
  new RegExp(`${assignmentTo(identifier)}\\{`, "g")

const QUOTED = new RegExp(STRING, "g")

/** Adjacent literals joined, escapes resolved: the value the compiler sees. */
const valueOf = (quoted: string): string =>
  (quoted.match(QUOTED) ?? []).map((literal) => unescape(literal.slice(1, -1))).join("")

/**
 * Every distinct value the file assigns to this identifier.
 *
 * Distinct, not first. `salt` is a function-local `static` in Apple's pairing
 * implementation and there are five of them, one per key-derivation step, with
 * five different values. There is no such thing as "the value of salt" in that
 * file, and returning the first would be a confident wrong answer of exactly
 * the kind this module exists to prevent, so the ambiguity is reported instead.
 *
 * A name repeated with the *same* value — the ordinary case of a constant
 * declared in two preprocessor-guarded arms — is not ambiguous, and collapses.
 */
const assigned = (identifier: string, source: string): ReadonlyArray<string> =>
  Array.from(
    new Set(
      [...source.matchAll(declarations(identifier))].map((match) => valueOf(match[1] ?? ""))
    )
  )

const literalIn = (identifier: string) =>
(source: string): Effect.Effect<string, SchemaIssue.Issue> => {
  const code = withoutComments(source)
  const values = assigned(identifier, code)
  const first = values[0]
  return first === undefined
    ? invalid(
      braced(identifier).test(code)
        ? `"${identifier}" is declared in this C source with a braced initialiser, ` +
          `not a string literal — read it with byteArray`
        : `no string literal assigned to "${identifier}" in this C source`
    )
    : values.length > 1
    ? invalid(
      `"${identifier}" is assigned ${values.length} different string literals in this C ` +
        `source (${values.map((value) => `"${escape(value)}"`).join(", ")}); ` +
        `it is a name reused per scope, so there is no single value to read`
    )
    : Effect.succeed(first)
}

/**
 * The value of a named C string constant.
 *
 * **Details**
 *
 * Reads both `static const uint8_t salt[] = "Pair-Setup-Encrypt-Salt";` and
 * `#define FOO "bar"`, resolves escapes, and joins adjacent literals the way
 * the compiler does.
 *
 * **When to use**
 *
 * For the salts, infos and nonces a key-derivation step is parameterised by.
 * These are the strings that must match the other end byte for byte, and they
 * are the strings most likely to be retyped with a hyphen in the wrong place —
 * which produces a different key and a failure that surfaces two messages later
 * as "authentication failed".
 *
 * **Gotchas**
 *
 * Fails, rather than guessing, when the file assigns the identifier more than
 * one value. That is common for short names: `salt` and `info` are
 * function-local statics in Apple's pairing implementation, each occurring
 * several times with different contents. Read those with `stringLiterals`, or
 * ask for a name that is unique in the file.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Cee } from "@castcli/source"
 *
 * const source = `static const uint8_t nonce[] = "PS-Msg05";`
 * const nonce = Schema.decodeUnknownEffect(Cee.stringLiteral("nonce"))(source)
 * // => "PS-Msg05"
 * ```
 *
 * @category codecs
 * @since 0.1.0
 */
export const stringLiteral = (identifier: string) =>
  CeeText.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transformOrFail(literalIn(identifier)),
      encode: SchemaGetter.transform((value: string) =>
        `static const uint8_t ${identifier}[] = "${escape(value)}";`
      )
    })
  )
