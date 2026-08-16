// A family of C enum constants, as a codec.

import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { invalid } from "../../Failure.ts"
import { withoutComments } from "../Comment.ts"
import { startingAt } from "../Identifier.ts"
import { Text } from "../Source.ts"
import { valueOf } from "./Expression.ts"
import { Member, Members } from "./Member.ts"

/**
 * A declaration of a member of the family: the name, then `=`, then everything
 * up to whatever ends the initialiser.
 *
 * Two details in here are the entire reason this module exists.
 *
 * The value runs to `,` or `;` or `}` — and *not* to a newline. The last member
 * of an enum has no trailing comma; it is terminated by the closing brace, and
 * that brace is usually on the next line. A pattern that stopped at the end of
 * the line, or one that required a comma, drops exactly one member per enum and
 * drops it silently. That is how `kHAPPairingMethod_PairResume` went missing:
 * the generated table simply had six entries where the header has seven, and
 * nothing anywhere failed.
 *
 * The `=(?!=)` is the other. Enum constants appear far more often as *uses*
 * than as declarations — `tlv->type == kHAPPairingTLVType_State` is on nearly
 * every page of the pairing implementation — and without the guard, `==` reads
 * as an assignment and the comparison's right-hand side is recorded as the
 * constant's value.
 */
const declarations = (prefix: string): RegExp =>
  new RegExp(`${startingAt(prefix)}(\\w+)\\s*=(?!=)([^,;}]+)`, "g")

interface Declaration {
  readonly name: string
  readonly expression: string
}

/**
 * The declarations in source order, keeping the first of any repeated name.
 *
 * A header declares some constants twice, in the two arms of a preprocessor
 * conditional, and nothing here runs the preprocessor — so both arms are
 * visible and one of them is not compiled. First-wins matches how these headers
 * are written: the guarded second definition is the fallback for a platform
 * this project is not, and taking the last would silently prefer it.
 */
const declared = (prefix: string, source: string): ReadonlyArray<Declaration> => {
  const all = [...withoutComments(source).matchAll(declarations(prefix))].map((match) => ({
    name: match[1] ?? "",
    expression: (match[2] ?? "").trim()
  }))
  return all.filter(
    (declaration, index) => all.findIndex((other) => other.name === declaration.name) === index
  )
}

/**
 * A declaration's expression, evaluated, or a failure that quotes it.
 *
 * The failure is the point. The obvious alternative — skip what will not
 * evaluate — turns a gap in the evaluator into a missing constant, and a
 * missing constant is invisible: generated output that is short by one entry
 * looks exactly like generated output.
 */
const evaluated = (
  prefix: string,
  declaration: Declaration
): Effect.Effect<Member, SchemaIssue.Issue> =>
  Option.match(valueOf(declaration.expression), {
    onNone: () =>
      invalid(
        `${prefix}${declaration.name} is declared as "${declaration.expression}", ` +
          `which is not a constant expression this reader can evaluate`
      ),
    onSome: (value) => Effect.succeed({ name: declaration.name, value })
  })

const membersIn = (prefix: string) =>
(source: string): Effect.Effect<Members, SchemaIssue.Issue> => {
  const found = declared(prefix, source)
  return found.length === 0
    ? invalid(`no enum members named "${prefix}…" in this C source`)
    : Effect.forEach(found, (declaration) => evaluated(prefix, declaration))
}

/**
 * The members, written back out as an enum body.
 *
 * Decimal rather than hexadecimal, because the value is a number by the time it
 * gets here and the base it was originally written in is not recoverable.
 * Re-decoding this gives the same members back, which is what makes a
 * round-trip test possible — and a round trip is the only check that the reader
 * agrees with itself about where a member's value ends.
 */
const rendered = (prefix: string) => (members: Members): string =>
  members.map((member) => `    ${prefix}${member.name} = ${member.value},`).join("\n")

/**
 * Every member of a family of C enum constants, read out of C source.
 *
 * **Details**
 *
 * `prefix` selects the family — `kHAPPairingTLVType_` — and is stripped from
 * each name, so `kHAPPairingTLVType_Salt` decodes to `{ name: "Salt", value: 2 }`.
 * The members come back in the order the source declares them.
 *
 * Handles what real headers contain: the last member of an enum, which has no
 * trailing comma; hexadecimal, decimal, octal and binary literals; `U`/`UL`
 * suffixes; parenthesised and shifted expressions such as `1U << 24U`; and a
 * name declared twice inside preprocessor-guarded blocks, where the first wins.
 *
 * **When to use**
 *
 * Whenever a number that goes on the wire is also written down in vendored
 * source. The alternative is transcription, and a transcribed constant is
 * correct on the day it is written; this one is correct or the build stops.
 *
 * **Gotchas**
 *
 * The preprocessor does not run, so a member whose value is a macro or another
 * constant fails the decode with a message quoting the expression. That is
 * deliberate — see `Expression`.
 *
 * A prefix matching nothing is a failure, not an empty array. An empty
 * vocabulary is the shape that a rename produces, and it is silent everywhere
 * downstream.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Cee } from "@castcli/source"
 *
 * const source = `
 *   HAP_OPTIONS_BEGIN(uint32_t, HAPPairingFlag) {
 *       kHAPPairingFlag_Transient = 1U << 4U,
 *       kHAPPairingFlag_Split = 1U << 24U,
 *   } HAP_OPTIONS_END(uint32_t, HAPPairingFlag);
 * `
 *
 * const flags = Schema.decodeUnknownEffect(Cee.enumeration("kHAPPairingFlag_"))(source)
 * // => [{ name: "Transient", value: 16 }, { name: "Split", value: 16777216 }]
 * ```
 *
 * @category codecs
 * @since 0.1.0
 */
export const enumeration = (prefix: string) =>
  Text.pipe(
    Schema.decodeTo(Members, {
      decode: SchemaGetter.transformOrFail(membersIn(prefix)),
      encode: SchemaGetter.transform(rendered(prefix))
    })
  )
