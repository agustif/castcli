// The same digits, as the number they exist to be.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Rfc } from "@castcli/source"
import { document } from "../Document.ts"

const decode = <S extends Schema.ConstraintCodec<unknown, string, never, never>>(
  schema: S,
  text: string
) => Schema.decodeUnknownEffect(schema)(text)

describe("Rfc.BigIntFromHexDigits", () => {
  it.effect("is the digits, read as one number", () =>
    Effect.gen(function*() {
      const digits = yield* decode(Rfc.fromSection("4.  A Group", Rfc.HexDigits), document)
      const value = yield* decode(Rfc.fromSection("4.  A Group", Rfc.BigIntFromHexDigits), document)
      assert.strictEqual(value, BigInt(`0x${digits}`))
    }))

  it.effect("fails on a section with no digits, rather than decoding to zero", () =>
    Effect.gen(function*() {
      // Zero is a plausible-looking modulus: every operation on it succeeds and
      // the result is wrong everywhere, with nothing pointing back at the read.
      const result = yield* Effect.exit(
        decode(Rfc.fromSection("3.  Preliminaries", Rfc.BigIntFromHexDigits), document)
      )
      assert.isTrue(result._tag === "Failure", "a section of prose decoded to a number")
    }))
})
