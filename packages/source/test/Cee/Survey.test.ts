// Every literal in a file, which is how a generated table is proved complete.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { NodeServices } from "@effect/platform-node"
import { Cee } from "@castcli/source"
import { HAP_PAIRING_PAIR_SETUP_C } from "./Vendor.ts"

const decode = <S extends Schema.ConstraintCodec<unknown, string, never, never>>(
  schema: S,
  text: string
) => Schema.decodeUnknownEffect(schema)(text)

const readFile = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem
    return yield* fs.readFileString(path)
  }).pipe(Effect.provide(NodeServices.layer))

describe("Cee.stringLiterals over the vendored pair-setup implementation", () => {
  it.effect("finds the salts and nonces the exchange is parameterised by", () =>
    Effect.gen(function*() {
      const all = yield* decode(Cee.stringLiterals, yield* readFile(HAP_PAIRING_PAIR_SETUP_C))

      // These two are the ones a pair-setup implementation cannot work without,
      // and they are the reason to survey rather than to enumerate: a table
      // naming only the salts somebody thought of looks exactly as finished as
      // a complete one.
      assert.include(all, "Pair-Setup-Encrypt-Salt")
      assert.include(all, "PS-Msg05")
      // The rest of the family, to show the survey is not finding two by luck.
      assert.include(all, "Pair-Setup-Encrypt-Info")
      assert.include(all, "Pair-Setup-Accessory-Sign-Salt")
      assert.include(all, "PS-Msg06")
    }))

  it.effect("does not report a header path as a value", () =>
    Effect.gen(function*() {
      const all = yield* decode(Cee.stringLiterals, yield* readFile(HAP_PAIRING_PAIR_SETUP_C))
      assert.isTrue(
        all.every((literal) => !literal.endsWith(".h")),
        "an #include path was surveyed as if it were a value"
      )
    }))

  it.effect("reports each literal once", () =>
    Effect.gen(function*() {
      const all = yield* decode(Cee.stringLiterals, yield* readFile(HAP_PAIRING_PAIR_SETUP_C))
      assert.strictEqual(new Set(all).size, all.length)
    }))
})

describe("Cee.stringLiterals", () => {
  it.effect("does not read quotation marks in a comment as source", () =>
    Effect.gen(function*() {
      const source = [
        `/* The old salt was "Pair-Setup-Salt", renamed in R6. */`,
        `static const uint8_t salt[] = "Pair-Setup-Encrypt-Salt";`
      ].join("\n")
      assert.deepStrictEqual(
        yield* decode(Cee.stringLiterals, source),
        ["Pair-Setup-Encrypt-Salt"]
      )
    }))

  it.effect("does not re-synchronise on the wrong quote after an escaped one", () =>
    Effect.gen(function*() {
      // `"say \"hi\""` is one literal. A reader that stopped at the first
      // unescaped-looking quote would report three, two of which are the code
      // between the real strings.
      const source = `const char* a = "say \\"hi\\""; const char* b = "next";`
      assert.deepStrictEqual(yield* decode(Cee.stringLiterals, source), [`say "hi"`, "next"])
    }))

  it.effect("round-trips the list it writes", () =>
    Effect.gen(function*() {
      const values = ["Pair-Setup-Encrypt-Salt", "PS-Msg05", `a "quoted" one`]
      const written = yield* Schema.encodeEffect(Cee.stringLiterals)(values)
      assert.deepStrictEqual(yield* decode(Cee.stringLiterals, written), values)
    }))
})
