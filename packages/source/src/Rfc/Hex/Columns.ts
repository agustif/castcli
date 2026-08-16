// The layout an RFC prints a large number in.
//
// Six columns of eight hexadecimal digits, indented. It is a presentation
// detail and it is also the only thing that separates a modulus from the
// paragraph above it, so it is stated once, here, and both the reader and the
// writer are derived from it — which is what makes a round trip a real check of
// the layout rather than of the length.

/** Columns per line, as the RFC editor lays them out. */
export const COLUMNS = 6

/** Digits per column: eight, one 32-bit word. */
export const WIDTH = 8

/**
 * A line that is nothing but hex laid out in columns.
 *
 * **Gotchas**
 *
 * Anchored at both ends on purpose. Prose contains hex-looking words —
 * `added`, `deface`, `bad` — so a rule that merely *found* hex in a line would
 * splice English into a prime and produce a number that is wrong in a way no
 * length check would catch. The leading `\s+` is part of that: the columns are
 * always indented, and a bare word at column zero is not a data line.
 *
 * @category patterns
 * @since 0.1.0
 */
export const HEX_LINE = new RegExp(
  `^\\s+[0-9A-Fa-f]{${WIDTH}}(?:\\s+[0-9A-Fa-f]{${WIDTH}})*\\s*$`
)
