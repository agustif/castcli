// The value of a C constant expression, without a C compiler.
//
// An enum member is not a number in the source; it is an expression the
// compiler folds. `0x13` and `1U << 24U` and `(1 << 4) | 1` are all ordinary,
// and a reader that understands only the first quietly loses the rest — which
// is how a flags enum becomes a table of the two members that happened to be
// written as literals.
//
// So this evaluates rather than pattern-matches. It is a precedence-climbing
// parser over the operators C allows in a constant expression, and it returns
// an Option: an expression it cannot evaluate is *not* zero, and not skipped.
// The caller turns the `none` into a decoding failure that names the member and
// quotes the expression, so an unsupported form is a message rather than an
// absence.
//
// What it deliberately does not do is resolve names. `sizeof`, a macro, or a
// reference to another constant all give `none`. Resolving them would mean
// running the preprocessor, and half-resolving them — treating an unknown name
// as zero, which is what C itself does inside `#if` — is exactly the failure
// mode being avoided.

import { Option } from "effect"

/**
 * The lexical shapes: a number in any of C's bases with any suffix, the
 * two-character shifts before the one-character operators that begin them, and
 * the punctuation.
 *
 * Ordering matters here in a way it does not in `Comment`: `<<` must be offered
 * before `<`-anything, or a shift lexes as two tokens and the parse fails.
 */
const TOKEN = /0[xX][0-9a-fA-F]+[uUlL]*|0[bB][01]+[uUlL]*|\d+[uUlL]*|<<|>>|[-+*/|&^~()]/g

/** `0x13U` → `0x13`. C's integer suffixes say what type it is, not what value. */
const unsuffixed = (token: string): string => token.replace(/[uUlL]+$/, "")

/**
 * A numeric literal in any base C writes one in.
 *
 * The octal case is the one worth having: `010` is 8 to a compiler and 10 to
 * anything that calls `Number` on it, and a constant that is off by two with no
 * other symptom is not something a test would think to look for.
 */
const numberOf = (token: string): Option.Option<number> => {
  const digits = unsuffixed(token)
  const value = /^0[xX]/.test(digits)
    ? Number.parseInt(digits.slice(2), 16)
    : /^0[bB]/.test(digits)
    ? Number.parseInt(digits.slice(2), 2)
    : /^0[0-7]+$/.test(digits)
    ? Number.parseInt(digits.slice(1), 8)
    : /^[0-9]+$/.test(digits)
    ? Number(digits)
    : Number.NaN
  return Number.isFinite(value) ? Option.some(value) : Option.none()
}

interface Operator {
  readonly precedence: number
  readonly apply: (left: number, right: number) => number
}

/**
 * The binary operators, at C's precedences.
 *
 * The shifts are arithmetic on purpose. JavaScript's `<<` truncates to a
 * *signed* 32-bit integer, so `1 << 31` is -2147483648 — and the flags read
 * here are `uint32_t`. A negative flag value written into generated output
 * compiles, compares unequal to everything a device sends, and gives no
 * indication why. Multiplying by a power of two has no such edge, and the
 * bitwise operators that genuinely need 32-bit semantics get their result
 * pushed back into unsigned range explicitly.
 */
const BINARY: Readonly<Record<string, Operator>> = {
  "|": { precedence: 1, apply: (left, right) => (left | right) >>> 0 },
  "^": { precedence: 2, apply: (left, right) => (left ^ right) >>> 0 },
  "&": { precedence: 3, apply: (left, right) => (left & right) >>> 0 },
  "<<": { precedence: 4, apply: (left, right) => left * 2 ** right },
  ">>": { precedence: 4, apply: (left, right) => Math.floor(left / 2 ** right) },
  "+": { precedence: 5, apply: (left, right) => left + right },
  "-": { precedence: 5, apply: (left, right) => left - right },
  "*": { precedence: 6, apply: (left, right) => left * right },
  "/": { precedence: 6, apply: (left, right) => Math.trunc(left / right) }
}

/** A value and what is left to parse after it. */
interface Parsed {
  readonly value: number
  readonly rest: ReadonlyArray<string>
}

/**
 * A literal, a parenthesised expression, or a unary operator applied to one.
 *
 * Written before `expression` and referring to it: the recursion through
 * parentheses is what makes this a parser rather than a scanner, and it is the
 * reason `(1U << 4U) | 1U` is not a special case.
 */
const primary = (tokens: ReadonlyArray<string>): Option.Option<Parsed> => {
  const head = tokens[0]
  const tail = tokens.slice(1)
  return head === undefined
    ? Option.none()
    : head === "("
    ? expression(tail, 0).pipe(
      Option.flatMap((inner) =>
        inner.rest[0] === ")"
          ? Option.some({ value: inner.value, rest: inner.rest.slice(1) })
          : Option.none()
      )
    )
    : head === "~"
    ? primary(tail).pipe(Option.map((operand) => ({ value: ~operand.value >>> 0, rest: operand.rest })))
    : head === "-"
    ? primary(tail).pipe(Option.map((operand) => ({ value: -operand.value, rest: operand.rest })))
    : head === "+"
    ? primary(tail)
    : numberOf(head).pipe(Option.map((value) => ({ value, rest: tail })))
}

/**
 * Fold operators onto a parsed left operand while they bind at least as
 * tightly as `minimum`.
 *
 * The right operand is parsed at `precedence + 1`, which is what makes every
 * operator here left-associative: `8 - 2 - 1` is 5 rather than 7. C has no
 * right-associative binary operator among these, so one rule covers all of
 * them.
 */
const climb = (left: Parsed, minimum: number): Option.Option<Parsed> => {
  const operator = BINARY[left.rest[0] ?? ""]
  return operator === undefined || operator.precedence < minimum
    ? Option.some(left)
    : primary(left.rest.slice(1)).pipe(
      Option.flatMap((right) => climb(right, operator.precedence + 1)),
      Option.flatMap((right) =>
        climb({ value: operator.apply(left.value, right.value), rest: right.rest }, minimum)
      )
    )
}

const expression = (
  tokens: ReadonlyArray<string>,
  minimum: number
): Option.Option<Parsed> => primary(tokens).pipe(Option.flatMap((first) => climb(first, minimum)))

/**
 * Lex, insisting that nothing was left over.
 *
 * This is where an identifier is caught. `kHAPPairingFlag_Transient | 1` lexes
 * to `["|", "1"]` with `kHAPPairingFlag_Transient` unconsumed, and a parser
 * handed only the tokens it recognised would happily evaluate the fragment. The
 * leftover check is the difference between "I cannot read this" and a confident
 * wrong number.
 */
const tokensOf = (source: string): Option.Option<ReadonlyArray<string>> =>
  source.replace(TOKEN, "").trim() === ""
    ? Option.some(source.match(TOKEN) ?? [])
    : Option.none()

/**
 * Evaluate a C constant expression.
 *
 * **Details**
 *
 * Handles the integer literals (hexadecimal, binary, octal, decimal, with any
 * `U`/`L` suffix), parentheses, unary `+ - ~`, and the binary operators
 * `| ^ & << >> + - * /` at C's own precedences.
 *
 * **Gotchas**
 *
 * Returns `none` — never a guess — for anything else: an identifier, a `sizeof`,
 * a character literal, a floating-point value, a comma expression. Callers are
 * expected to turn that into a failure that quotes the expression, because a
 * form this cannot read is a gap in this function, and a silently dropped enum
 * member is the exact bug this whole module was written to prevent.
 *
 * Arithmetic is JavaScript's, on doubles. That is exact for everything up to
 * 2^53, which covers every `uint32_t` these enums hold, but it is not C's
 * wrapping arithmetic: an expression that would overflow a `uint32_t` in the
 * compiler gives the un-wrapped value here.
 *
 * @example
 * ```ts
 * import { Option } from "effect"
 * import { valueOf } from "./Expression.ts"
 *
 * valueOf("0x13")           // => Option.some(19)
 * valueOf("1U << 24U")      // => Option.some(16777216)
 * valueOf("(1 << 4) | 1")   // => Option.some(17)
 * valueOf("sizeof(int)")    // => Option.none()
 * ```
 *
 * @category utils
 * @since 0.1.0
 */
export const valueOf = (source: string): Option.Option<number> =>
  tokensOf(source).pipe(
    Option.flatMap((tokens) => expression(tokens, 0)),
    Option.flatMap((parsed) =>
      parsed.rest.length === 0 && Number.isFinite(parsed.value)
        ? Option.some(parsed.value)
        : Option.none()
    )
  )
