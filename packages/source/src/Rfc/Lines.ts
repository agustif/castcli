// A document as its lines.
//
// Every reader below works line by line — headings are lines, hex columns are
// lines, a labelled value is a line — so the split is stated once rather than
// three times. The pattern matters: RFCs are distributed with CRLF as often as
// with LF, and a reader that splits on "\n" alone leaves a carriage return on
// the end of every line, which quietly breaks any rule anchored with `$`.

/**
 * Split a document into lines, tolerating either line ending.
 *
 * @example
 * ```ts
 * import { linesOf } from "./Lines.ts"
 *
 * linesOf("one\r\ntwo") // => ["one", "two"]
 * ```
 *
 * @category utils
 * @since 0.1.0
 */
export const linesOf = (text: string): ReadonlyArray<string> => text.split(/\r?\n/)
