// C's string escapes, both ways.
//
// The literals worth reading out of this source are HKDF salts and nonces —
// "Pair-Setup-Encrypt-Salt", "PS-Msg05" — and those are plain ASCII, so it
// would be easy to argue that stripping the quotes is enough. It is not, and
// the reason is that these strings become key material. A backslash left
// undecoded is one extra byte in the salt, the derived key differs from the
// device's, and the failure surfaces as an authentication error several
// messages later with nothing pointing back here.

/** The escapes with a fixed meaning, as against the numeric ones. */
const SIMPLE: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  e: "\u001b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  "\"": "\"",
  "?": "?"
}

/** A backslash and whatever it introduces: hex, octal, or a single character. */
const ESCAPE = /\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|[\s\S])/g

/** The characters that must be written back as escapes, and how. */
const LITERAL: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  "\"": "\\\"",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\0": "\\0"
}

const ESCAPABLE = /[\\"\n\r\t\0]/g

/**
 * The value of a C string literal's contents, escapes resolved.
 *
 * **Details**
 *
 * Takes the text *between* the quotes, not the quoted literal. Handles the
 * named escapes, `\xNN`, and octal `\NNN` — which covers `\0`, the one that
 * matters, since a literal used as key material may legitimately contain a NUL.
 *
 * **Gotchas**
 *
 * Works in UTF-16 code units, not bytes. A source file containing a non-ASCII
 * literal, or a `\x` escape above 0x7F, gives a JavaScript string whose UTF-8
 * encoding is not what the C compiler put in the binary. Every literal this is
 * used on in practice is ASCII; a caller that needs bytes from a non-ASCII
 * literal wants `byteArray` and an explicit array.
 *
 * @example
 * ```ts
 * import { unescape } from "./Escape.ts"
 *
 * unescape("PS-Msg05")       // => "PS-Msg05"
 * unescape("a\\tb\\x41")     // => "a\tbA"
 * ```
 *
 * @category utils
 * @since 0.1.0
 */
export const unescape = (contents: string): string =>
  contents.replace(ESCAPE, (_, body: string) =>
    body.startsWith("x")
      ? String.fromCharCode(Number.parseInt(body.slice(1), 16))
      : /^[0-7]{1,3}$/.test(body)
      ? String.fromCharCode(Number.parseInt(body, 8))
      // An unknown escape is C's own behaviour: `\q` is `q`. Preferring the
      // character over a failure keeps a decode from stopping on a literal
      // nobody was asking about.
      : SIMPLE[body] ?? body)

/**
 * The inverse: a value, written as the contents of a C string literal.
 *
 * **Details**
 *
 * Only the characters that must be escaped are escaped, so an ordinary salt
 * comes back out looking exactly as it does in the source. That is what makes
 * an encode of a decode recognisable to a human reading the diff.
 *
 * @example
 * ```ts
 * import { escape } from "./Escape.ts"
 *
 * escape("Pair-Setup-Encrypt-Salt") // => "Pair-Setup-Encrypt-Salt"
 * escape("a\nb")                    // => "a\\nb"
 * ```
 *
 * @category utils
 * @since 0.1.0
 */
export const escape = (value: string): string =>
  value.replace(ESCAPABLE, (character) => LITERAL[character] ?? character)
