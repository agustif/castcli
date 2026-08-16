// How a named constant's declaration is spelled, as regex source.
//
// Two readers want the same left-hand side and differ only in what follows the
// `=`: `Text` expects quotes, `Bytes` expects braces. Stating the left-hand
// side once means they cannot drift — and, less obviously, it means each of
// them can cheaply check for the *other's* shape, so asking for the bytes of
// something declared as a string gets a message saying so instead of a bare
// "not found".

import { whole } from "../Identifier.ts"

/**
 * A C string literal, quotes included and escapes left intact.
 *
 * The body is `[^"\\]|\\[\s\S]`, not `[^"]`, so a literal containing an escaped
 * quote — `"say \"hi\""` — is one match rather than two truncated ones. That is
 * also what stops a survey of a file from re-synchronising on the wrong quote
 * and reporting the *code between* two strings as if it were a string.
 *
 * @category patterns
 * @since 0.1.0
 */
export const STRING = `"(?:[^"\\\\]|\\\\[\\s\\S])*"`

/**
 * The left-hand side of a declaration that gives `identifier` a value, up to
 * and including the point where the value begins.
 *
 * **Details**
 *
 * Two spellings, because this source uses both: `#define NAME value`, and a
 * definition with an initialiser — `static const uint8_t name[] = value`. The
 * array brackets are optional and their contents unconstrained, since `[]`,
 * `[32]` and `[SOME_MACRO]` all occur and the declared length is not something
 * these readers have an opinion about.
 *
 * **Gotchas**
 *
 * `whole` on both spellings is load-bearing: without the right-hand boundary,
 * a request for `salt` matches the declaration of `salt_len`, and a request for
 * `srp_b` matches `srp_B` on a case-insensitive read of the same idea. The
 * `#define` arm needs `[ \t]+` rather than `\s+` so that a macro defined as
 * nothing — `#define NAME` followed by end of line — does not swallow the next
 * line's value.
 *
 * @example
 * ```ts
 * import { assignmentTo, STRING } from "./Declaration.ts"
 *
 * const salt = new RegExp(`${assignmentTo("salt")}(${STRING})`, "g")
 * ```
 *
 * @category patterns
 * @since 0.1.0
 */
export const assignmentTo = (identifier: string): string =>
  `(?:#[ \\t]*define[ \\t]+${whole(identifier)}[ \\t]+` +
  `|${whole(identifier)}\\s*(?:\\[[^\\]]*\\])?\\s*=\\s*)`
