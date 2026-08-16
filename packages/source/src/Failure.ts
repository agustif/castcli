// How a source reader says no.
//
// Every codec in this package decodes from the text of a file somebody else
// maintains — an RFC, a vendored C header — and every one of them can be handed
// a revision in which the thing it wants has moved. The failure is always the
// same kind of thing: "I looked for X and this document does not contain it".
//
// Constructing it in one place is not tidiness. A caller catching a decode
// failure from `Rfc` and one from `Cee` sees the same issue type with the same
// shape of message, so error handling is written once; and the message is
// forced to name what was looked for, which is the entire difference between a
// generator that stops and a generator that emits a constant of `""`.

import { Effect, SchemaIssue } from "effect"

/**
 * Fail a decode with a message naming what was looked for.
 *
 * **Details**
 *
 * The message goes in `InvalidValue`'s *first* argument, which is the issue's
 * annotations. The second argument is the offending input, retained only when
 * `reportInput` is set — so `new InvalidValue(undefined, { message })` compiles,
 * fails, and silently discards the message, leaving every failure in this
 * package reading "Expected a valid value". That is worth stating because it is
 * the one mistake here that a test asserting only "it failed" cannot catch, and
 * this package's entire claim is that its failures say what was looked for.
 *
 * The input slot is left empty on purpose: the input is an entire file, and
 * quoting it back would bury the message it was written to carry.
 *
 * **When to use**
 *
 * Inside `SchemaGetter.transformOrFail` or `SchemaTransformation.transformOrFail`
 * in this package, wherever a reader would otherwise be tempted to return an
 * empty array, an empty string or a zero. The whole point of reading a source
 * through a codec rather than a regular expression is that absence is loud, and
 * that only holds if every reader routes absence through here.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { invalid } from "./Failure.ts"
 *
 * const found: ReadonlyArray<string> = []
 * const result = found.length === 0
 *   ? invalid(`no section "4.  3072-bit Group" in this document`)
 *   : Effect.succeed(found)
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const invalid = <A = never>(message: string): Effect.Effect<A, SchemaIssue.Issue> =>
  Effect.fail(new SchemaIssue.InvalidValue({ message }))
