// Getting the commentary out of the way before reading anything else.
//
// Every reader in this module would otherwise be wrong on the same input, and
// the vendored HomeKit sources are the input in question: their enums carry a
// doc comment per member that names *other* members of the same enum
// ("When set with kHAPPairingFlag_Transient …"), and their headers carry
// commented-out code. A reader that scans raw text finds those and cannot tell
// them from declarations.
//
// The removal has to know about string literals, which is why this is a scanner
// and not a pair of replacements. `"http://example"` contains what looks like a
// line comment, and a naive strip of `//` to end of line turns that string into
// an unterminated one — silently changing the value of every literal after it
// on that line.

/**
 * One pass over the four things whose contents must not be read as code: a
 * string literal, a character literal, a block comment, a line comment.
 *
 * Alternation order matters only among candidates starting at the same
 * position, and no two of these can start at the same character, so the order
 * here is for reading rather than for precedence. What does matter is that a
 * match consumes its whole construct: an apostrophe inside a comment is never
 * scanned as the start of a character literal, because the comment that
 * contains it was consumed first.
 */
const CONSTRUCT = /"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g

/**
 * C source with its comments blanked out.
 *
 * **Details**
 *
 * Comments are replaced by spaces rather than deleted, and their newlines are
 * kept. That keeps every remaining character at its original line and column,
 * so a declaration that followed a block comment on the same line does not
 * slide up against whatever preceded it — which would let a reader match across
 * what used to be two statements.
 *
 * **When to use**
 *
 * Before any regular expression over C source, without exception. The one
 * thing it does not do is expand the preprocessor, so `#if`-guarded code is
 * still present and readers must handle a name that is declared twice.
 *
 * @example
 * ```ts
 * import { withoutComments } from "./Comment.ts"
 *
 * withoutComments(`int x = 1; // set to 2 later`)
 * // => `int x = 1;                 `
 *
 * // A comment marker inside a string is not a comment.
 * withoutComments(`const char* u = "http://a";`)
 * // => `const char* u = "http://a";`
 * ```
 *
 * @category utils
 * @since 0.1.0
 */
export const withoutComments = (source: string): string =>
  source.replace(
    CONSTRUCT,
    (construct) =>
      construct.startsWith("/") ? construct.replace(/[^\n]/g, " ") : construct
  )
