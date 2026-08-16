// What a heading is, and what makes one heading part of another.
//
// This is the whole of the nesting rule, kept apart from the code that slices
// a document so that the rule can be read — and got wrong — in one place.

/**
 * What a heading looks like: `4.  3072-bit Group`, `A.1.  Notation`.
 *
 * **Gotchas**
 *
 * Tested against the *trimmed* line, because the indentation is not fixed
 * across the series. RFC 5054 indents its headings three spaces; others start
 * them in column zero. Matching column zero — which this did first — finds no
 * heading at all in half the corpus and, worse, finds the *start* heading by
 * substring while never finding an end, so a section silently runs to the end
 * of the document.
 */
const HEADING = /^(?:[0-9]+|[A-Z])(?:\.[0-9]+)*\.\s+\S/

/**
 * The numbering of a heading line: `4.1.  A Subsection` → `["4", "1"]`.
 *
 * **Details**
 *
 * A line that is not a heading gives the empty array, which is what callers
 * test for. Appendices number as a letter followed by digits — `A.1.` — so the
 * first part is not always numeric and the parts are kept as strings.
 *
 * @example
 * ```ts
 * import { numbering } from "./Heading.ts"
 *
 * numbering("   4.1.  A Subsection") // => ["4", "1"]
 * numbering("   ordinary prose")     // => []
 * ```
 *
 * @category utils
 * @since 0.1.0
 */
export const numbering = (line: string): ReadonlyArray<string> => {
  const trimmed = line.trim()
  const found = HEADING.test(trimmed) ? /^([0-9A-Z](?:\.[0-9]+)*)\./.exec(trimmed) : null
  return found === null ? [] : (found[1] ?? "").split(".")
}

/**
 * Whether one numbering sits underneath another: `["4", "1"]` descends from
 * `["4"]`, and `["5"]` does not.
 *
 * **Details**
 *
 * Nesting is read from the numbering, not from indentation, and this is the
 * predicate that says so. It is a strict descent — a heading does not descend
 * from itself — because it is used to find where a section *ends*, and a
 * section does not end at its own heading.
 *
 * @example
 * ```ts
 * import { descends } from "./Heading.ts"
 *
 * descends(["4", "1"], ["4"]) // => true
 * descends(["5"], ["4"])      // => false
 * ```
 *
 * @category utils
 * @since 0.1.0
 */
export const descends = (
  candidate: ReadonlyArray<string>,
  from: ReadonlyArray<string>
): boolean =>
  candidate.length > from.length && from.every((part, index) => candidate[index] === part)
