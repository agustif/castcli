// Every string literal in a file, for proving a table complete.
//
// The other readers here answer questions. This one exists so a generator can
// ask whether it has asked all the questions.
//
// A table of key-derivation salts is easy to make plausible and hard to make
// complete: the generator names the salts it knows about, they extract cleanly,
// the output looks right, and the one salt nobody thought of is simply absent —
// with no failure anywhere, because nothing looked for it. Surveying the source
// turns that into something checkable. Every literal in the file is enumerated,
// the generator subtracts the ones its output accounts for, and whatever
// remains is a finding rather than a shrug.

import { Schema, SchemaGetter } from "effect"
import { withoutComments } from "./Comment.ts"
import { escape, unescape } from "./Literal/Escape.ts"
import { STRING } from "./Literal/Declaration.ts"
import { Text } from "./Source.ts"

const QUOTED = new RegExp(STRING, "g")

/**
 * `#include "HAP+Internal.h"` is a string literal to the grammar and a filename
 * to everyone else.
 *
 * Dropping include paths is the one editorial decision in this reader, and it
 * is made here rather than left to every caller. The alternative is a survey
 * whose first dozen entries are header names, which makes the completeness
 * check tedious enough that people stop running it — and a check nobody runs is
 * worth less than no check, because it looks like coverage.
 */
const INCLUDE = /^[ \t]*#[ \t]*include[^\n]*$/gm

/**
 * Every distinct string literal in a C file, in the order it first appears.
 *
 * **Details**
 *
 * Comments are removed first, so prose containing quotation marks is not
 * mistaken for source; `#include` lines are removed too, since a header path is
 * not a value. Escapes are resolved, so what comes back is what the compiler
 * would put in the binary. Adjacent literals are *not* joined here, unlike in
 * `stringLiteral`: a survey reports what is written, and a concatenation is two
 * things written.
 *
 * **When to use**
 *
 * As the completeness half of a generator. Extract the constants you know
 * about, then survey the file and assert that everything left over is
 * accounted for — so that a salt added upstream in a later revision fails the
 * build instead of quietly not existing.
 *
 * **Gotchas**
 *
 * The empty array is a legitimate result: a file may genuinely contain no
 * string literals, and unlike an absent identifier that is an answer rather
 * than a failure. A caller relying on this for a completeness check should
 * assert that the survey is non-empty before trusting its emptiness elsewhere.
 *
 * Character literals are not string literals and are not included. Neither is
 * anything produced by macro expansion, since nothing here expands macros.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Cee } from "@castcli/source"
 *
 * const source = `static const uint8_t salt[] = "Pair-Setup-Encrypt-Salt";`
 * const all = Schema.decodeUnknownEffect(Cee.stringLiterals)(source)
 * // => ["Pair-Setup-Encrypt-Salt"]
 * ```
 *
 * @category codecs
 * @since 0.1.0
 */
export const stringLiterals = Text.pipe(
  Schema.decodeTo(Schema.Array(Schema.String), {
    decode: SchemaGetter.transform((source: string) =>
      Array.from(
        new Set(
          (withoutComments(source).replace(INCLUDE, "").match(QUOTED) ?? []).map((literal) =>
            unescape(literal.slice(1, -1))
          )
        )
      )
    ),
    // Back out as one literal per line. Not a C file — there is no file to
    // reconstruct — but enough that decoding it returns the same list, which is
    // the property a round-trip test can hold on to.
    encode: SchemaGetter.transform((values: ReadonlyArray<string>) =>
      values.map((value) => `"${escape(value)}"`).join("\n")
    )
  })
)
