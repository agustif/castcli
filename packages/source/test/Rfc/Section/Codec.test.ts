// Addressing a section by its heading.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Rfc } from "@castcli/source"
import { document } from "../Document.ts"

const decode = <S extends Schema.ConstraintCodec<unknown, string, never, never>>(
  schema: S,
  text: string
) => Schema.decodeUnknownEffect(schema)(text)

describe("Rfc.fromSection", () => {
  it.effect("reads the section under its heading, and stops at the next one", () =>
    Effect.gen(function*() {
      const body = yield* decode(Rfc.fromSection("4.  A Group", Schema.String), document)
      assert.include(body, "The generator is: 5.")
      // A subsection belongs to its parent. It is indented exactly as far as
      // the parent heading, so this is the case an indentation rule got wrong.
      assert.include(body, "AAAAAAAA")
      assert.notInclude(body, "BBBBBBBB")
    }))

  it.effect("fails when the heading is not there, rather than returning nothing", () =>
    Effect.gen(function*() {
      const result = yield* Effect.exit(
        decode(Rfc.fromSection("9.  Absent", Schema.String), document)
      )
      assert.isTrue(result._tag === "Failure", "an absent section decoded successfully")
    }))

  it.effect("says which heading it could not find", () =>
    Effect.gen(function*() {
      // The message is the difference between a build that stops with an
      // explanation and one that emits a constant of "". It is asserted rather
      // than assumed because a failure with a lost message still fails, so the
      // test above cannot tell the two apart.
      const error = yield* Effect.flip(
        decode(Rfc.fromSection("9.  Absent", Schema.String), document)
      )
      assert.include(error.message, "9.  Absent")
    }))

  it.effect("round-trips a section back under its own heading", () =>
    Effect.gen(function*() {
      const body = yield* decode(Rfc.fromSection("4.  A Group", Schema.String), document)
      const laid = yield* Schema.encodeEffect(Rfc.fromSection("4.  A Group", Schema.String))(body)
      assert.strictEqual(yield* decode(Rfc.fromSection("4.  A Group", Schema.String), laid), body)
    }))
})
