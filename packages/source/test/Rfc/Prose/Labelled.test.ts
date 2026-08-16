// Values an RFC states in a sentence.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Rfc } from "@castcli/source"
import { document } from "../Document.ts"

const decode = <S extends Schema.ConstraintCodec<unknown, string, never, never>>(
  schema: S,
  text: string
) => Schema.decodeUnknownEffect(schema)(text)

describe("Rfc.labelled", () => {
  it.effect("reads a value stated in a sentence", () =>
    Effect.gen(function*() {
      const generator = yield* decode(
        Rfc.fromSection("4.  A Group", Rfc.labelled("The generator is:", Schema.FiniteFromString)),
        document
      )
      assert.strictEqual(generator, 5)
    }))

  it.effect("fails when the sentence is not there", () =>
    Effect.gen(function*() {
      const result = yield* Effect.exit(
        decode(
          Rfc.fromSection("4.  A Group", Rfc.labelled("The modulus is:", Schema.FiniteFromString)),
          document
        )
      )
      assert.isTrue(result._tag === "Failure", "an absent sentence decoded successfully")
    }))

  it.effect("names the sentence it looked for", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        decode(
          Rfc.fromSection("4.  A Group", Rfc.labelled("The modulus is:", Schema.FiniteFromString)),
          document
        )
      )
      assert.include(error.message, "The modulus is:")
    }))
})
