// That a failure actually carries its message.
//
// This looks like a test of the Effect API rather than of this package, and in
// a sense it is. It is here because the mistake it catches is invisible to
// every other test in the package: `SchemaIssue.InvalidValue` takes its
// annotations first and the offending input second, so passing
// `(undefined, { message })` compiles, fails, and discards the message — and a
// test asserting "the decode failed" still passes.
//
// The entire claim of this package is that a source which moves produces a
// message naming what was looked for. If the message is silently dropped, the
// claim is false and nothing else notices.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Cee, Rfc } from "@castcli/source"

describe("a decoding failure from this package", () => {
  it.effect("carries the message the reader wrote, from Rfc", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        Schema.decodeUnknownEffect(Rfc.fromSection("9.  Absent", Schema.String))("nothing here")
      )
      assert.include(error.message, "9.  Absent")
      assert.notStrictEqual(error.message, "Expected a valid value")
    }))

  it.effect("carries the message the reader wrote, from Cee", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        Schema.decodeUnknownEffect(Cee.enumeration("kAbsent_"))("int x;")
      )
      assert.include(error.message, "kAbsent_")
      assert.notStrictEqual(error.message, "Expected a valid value")
    }))
})
