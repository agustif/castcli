// Named string constants, read out of Apple's pairing implementation.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { NodeServices } from "@effect/platform-node"
import { Cee } from "@castcli/source"
import { AWKWARD_NAMES, HAP_CRYPTO_TEST_C, HAP_PAIRING_PAIR_SETUP_C } from "../Vendor.ts"

const decode = <S extends Schema.ConstraintCodec<unknown, string, never, never>>(
  schema: S,
  text: string
) => Schema.decodeUnknownEffect(schema)(text)

const readFile = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem
    return yield* fs.readFileString(path)
  }).pipe(Effect.provide(NodeServices.layer))

describe("Cee.stringLiteral over the vendored HomeKit source", () => {
  it.effect("reads a constant declared once in the file", () =>
    Effect.gen(function*() {
      const user = yield* decode(Cee.stringLiteral("srp_user"), yield* readFile(HAP_CRYPTO_TEST_C))
      assert.strictEqual(user, "alice")
    }))

  it.effect("refuses a name the file gives several values", () =>
    Effect.gen(function*() {
      // `salt` is a function-local `static` in the pair-setup implementation
      // and there are five of them, one per key-derivation step, with five
      // different values. There is no such thing as "the value of salt" in that
      // file; returning the first would be a confident wrong answer, and the
      // one it would return happens to be the right one for M4 and wrong for
      // every other step.
      const error = yield* Effect.flip(
        decode(Cee.stringLiteral("salt"), yield* readFile(HAP_PAIRING_PAIR_SETUP_C))
      )
      assert.include(error.message, "Pair-Setup-Encrypt-Salt")
      assert.include(error.message, "MFi-Pair-Setup-Salt")
    }))

  it.effect("says to use byteArray when the value is a braced initialiser", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        decode(Cee.stringLiteral("srp_salt"), yield* readFile(HAP_CRYPTO_TEST_C))
      )
      assert.include(error.message, "byteArray")
    }))
})

describe("Cee.stringLiteral", () => {
  it.effect("reads a #define as well as a declaration", () =>
    Effect.gen(function*() {
      const value = yield* decode(Cee.stringLiteral("FOO"), `#define FOO "bar"`)
      assert.strictEqual(value, "bar")
    }))

  it.effect("does not match a name that merely contains the one asked for", () =>
    Effect.gen(function*() {
      // `salt` occurs inside `hkdf_salt`. Without a boundary on both sides, the
      // first declaration in the file wins and the answer is the wrong salt —
      // which is indistinguishable from the right one until a key fails to
      // agree with the device's.
      const value = yield* decode(Cee.stringLiteral("salt"), AWKWARD_NAMES)
      assert.strictEqual(value, "this one")
    }))

  it.effect("joins adjacent literals the way the compiler does", () =>
    Effect.gen(function*() {
      // C concatenates these. A reader taking only the first returns a value
      // that is a prefix of the real one — the worst possible failure for key
      // material, because it is the right shape and the right characters.
      const value = yield* decode(
        Cee.stringLiteral("s"),
        `static const uint8_t s[] = "Pair-Setup-" "Encrypt-Salt";`
      )
      assert.strictEqual(value, "Pair-Setup-Encrypt-Salt")
    }))

  it.effect("resolves escapes", () =>
    Effect.gen(function*() {
      // The NUL is the one that earns the escape handling: a salt may
      // legitimately contain one, and left as a backslash and a zero it is two
      // extra bytes of key material and a key that silently differs.
      const value = yield* decode(Cee.stringLiteral("s"), `#define s "a\\tb\\x41\\0c"`)
      assert.strictEqual(value, "a\tbA\u0000c")
    }))

  it.effect("ignores a declaration that is commented out", () =>
    Effect.gen(function*() {
      const source = [
        `// static const uint8_t s[] = "the old value";`,
        `static const uint8_t s[] = "the current value";`
      ].join("\n")
      assert.strictEqual(yield* decode(Cee.stringLiteral("s"), source), "the current value")
    }))

  it.effect("fails on an absent identifier, naming it", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(decode(Cee.stringLiteral("nowhere"), AWKWARD_NAMES))
      assert.include(error.message, "nowhere")
    }))

  it.effect("round-trips through the declaration it writes", () =>
    Effect.gen(function*() {
      const codec = Cee.stringLiteral("s")
      const written = yield* Schema.encodeEffect(codec)("a\"b\nc")
      assert.strictEqual(yield* decode(codec, written), "a\"b\nc")
    }))
})
