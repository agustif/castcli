// Hexadecimal in the columns an RFC prints it in.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { NodeServices } from "@effect/platform-node"
import { Rfc } from "@castcli/source"
import { document, RFC_5054 } from "../Document.ts"

const decode = <S extends Schema.ConstraintCodec<unknown, string, never, never>>(
  schema: S,
  text: string
) => Schema.decodeUnknownEffect(schema)(text)

describe("Rfc.HexDigits", () => {
  it.effect(
    "round-trips the published layout of a real RFC",
    () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem
        const rfc = yield* fs.readFileString(RFC_5054)

        const section = yield* decode(Rfc.fromSection("4.  3072-bit Group", Schema.String), rfc)
        const digits = yield* decode(Rfc.HexDigits, section)
        const columns = yield* Schema.encodeEffect(Rfc.HexDigits)(digits)

        // Encoding lays the digits back out in the RFC's own columns, and
        // decoding that gives the same number back. This is what checks that
        // the reader understood the layout, rather than happening to produce
        // something of the right length.
        assert.strictEqual(yield* decode(Rfc.HexDigits, columns), digits)
        assert.strictEqual(digits.length, 768, "the 3072-bit modulus is 768 hex digits")
      }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("does not read hexadecimal out of prose", () =>
    Effect.gen(function*() {
      // `deface` and `bad` are words in section 3 that are also valid hex. A
      // reader that took every hex-shaped token would splice English into a
      // number, and the result would be the right length and wrong.
      const digits = yield* decode(Rfc.fromSection("3.  Preliminaries", Rfc.HexDigits), document)
      assert.strictEqual(digits, "", `read ${digits} out of a paragraph of prose`)
    }))

  it.effect("takes every column of hex in the text it is given", () =>
    Effect.gen(function*() {
      // 64 digits in the section itself and 8 more in its subsection: the rule
      // is "every hex-only line in this text", not "the first block". Narrowing
      // is the caller's job, through the section it asks for.
      //
      // The risk that carries — a subsection gaining a hex table and silently
      // lengthening a modulus — is caught downstream, where the extracted
      // number is checked for primality rather than for length.
      const digits = yield* decode(Rfc.fromSection("4.  A Group", Rfc.HexDigits), document)
      assert.strictEqual(digits.length, 72)
    }))
})
