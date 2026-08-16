// Cutting one section out of a document.

import { linesOf } from "../Lines.ts"
import { descends, numbering } from "./Heading.ts"

/**
 * The lines under a heading, up to the next heading that is not part of it.
 *
 * **Details**
 *
 * Nesting is read from the *numbering*, not from indentation. That distinction
 * is the whole of it: RFC 5054 indents `4.1.  Subsection` exactly as far as
 * `4.  Section`, so an indentation rule ends section 4 at its own first
 * subsection and silently returns a fragment — which is worse than failing,
 * because a fragment decodes.
 *
 * Page furniture — `[Page 12]`, form feeds, running headers — is left in
 * place, because every reader above ignores lines it does not recognise, and
 * stripping it here would mean deciding what a page looks like on behalf of
 * readers that do not care.
 *
 * **Gotchas**
 *
 * An absent heading and a heading with an empty body both give the empty
 * array. The distinction has no reader: an empty section is not a value anyone
 * wants either, so the codec above turns both into the same failure.
 *
 * @example
 * ```ts
 * import { bodyOf } from "./Body.ts"
 *
 * bodyOf("4.  A Group\n   text\n5.  After\n   more", "4.  A Group") // => ["   text"]
 * ```
 *
 * @category utils
 * @since 0.1.0
 */
export const bodyOf = (text: string, heading: string): ReadonlyArray<string> => {
  const wanted = heading.trim()
  const lines = linesOf(text)
  const start = lines.findIndex((line) => line.trim() === wanted)
  const level = numbering(wanted)
  const rest = start < 0 ? [] : lines.slice(start + 1)
  const end = rest.findIndex((line) => {
    const found = numbering(line)
    return found.length > 0 && !descends(found, level)
  })
  return start < 0 ? [] : end < 0 ? rest : rest.slice(0, end)
}
