// Test vectors, read out of Apple's own crypto tests.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { NodeServices } from "@effect/platform-node"
import { Cee } from "@castcli/source"
import { COMMENTED_BYTES, HAP_CRYPTO_TEST_C } from "../Vendor.ts"

const decode = <S extends Schema.ConstraintCodec<unknown, string, never, never>>(
  schema: S,
  text: string
) => Schema.decodeUnknownEffect(schema)(text)

const readFile = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem
    return yield* fs.readFileString(path)
  }).pipe(Effect.provide(NodeServices.layer))

describe("Cee.byteArray over the vendored HomeKit tests", () => {
  it.effect("reads the SRP salt, laid out across two lines", () =>
    Effect.gen(function*() {
      const salt = yield* decode(Cee.byteArray("srp_salt"), yield* readFile(HAP_CRYPTO_TEST_C))

      // RFC 5054 Appendix B's salt, which is where Apple's vectors start from.
      assert.deepStrictEqual(
        Array.from(salt),
        [0xBE, 0xB2, 0x53, 0x79, 0xD1, 0xA8, 0x58, 0x1E, 0xB5, 0xA7, 0x27, 0x67, 0x3A, 0x24, 0x41, 0xEE]
      )
    }))

  it.effect("reads a vector that runs over many lines", () =>
    Effect.gen(function*() {
      const source = yield* readFile(HAP_CRYPTO_TEST_C)

      // The proofs are the valuable part of these vectors: the published
      // specification stops at the session key, and the proofs are where this
      // SRP departs from both RFC 2945 and RFC 5054. They are SHA-512 output,
      // so the length is the check that nothing was truncated at a line break.
      assert.strictEqual((yield* decode(Cee.byteArray("srp_m1"), source)).length, 64)
      assert.strictEqual((yield* decode(Cee.byteArray("srp_m2"), source)).length, 64)
      // The 3072-bit group makes the verifier 384 bytes.
      assert.strictEqual((yield* decode(Cee.byteArray("srp_v"), source)).length, 384)
    }))

  it.effect("fails on an identifier that is not there", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        decode(Cee.byteArray("srp_nonexistent"), yield* readFile(HAP_CRYPTO_TEST_C))
      )
      // Never an empty array. A vector of zero bytes hashes to something, and
      // the test built on it fails somewhere else entirely.
      assert.include(error.message, "srp_nonexistent")
    }))

  it.effect("says to use stringLiteral when the value is quoted", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        decode(Cee.byteArray("srp_user"), yield* readFile(HAP_CRYPTO_TEST_C))
      )
      assert.include(error.message, "stringLiteral")
    }))
})

describe("Cee.byteArray", () => {
  it.effect("tolerates comments, line breaks and a trailing comma inside the braces", () =>
    Effect.gen(function*() {
      // All three occur in formatted C and none of them is the value. A reader
      // that counted commas, or that split on lines, gets a different number of
      // bytes — and a key derived from the wrong number of bytes is simply a
      // different key.
      const bytes = yield* decode(Cee.byteArray("vector"), COMMENTED_BYTES)
      assert.deepStrictEqual(Array.from(bytes), [0, 1, 2, 3])
    }))

  it.effect("evaluates elements that are expressions rather than literals", () =>
    Effect.gen(function*() {
      const bytes = yield* decode(
        Cee.byteArray("v"),
        `static const uint8_t v[] = { 1 << 4, 0x0F | 0xF0, 010 };`
      )
      assert.deepStrictEqual(Array.from(bytes), [16, 255, 8])
    }))

  it.effect("fails on an element that does not fit in a byte", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        decode(Cee.byteArray("v"), `static const uint8_t v[] = { 0x00, 256 };`)
      )
      assert.include(error.message, "256")
    }))

  it.effect("fails on an element it cannot evaluate, rather than shortening the array", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        decode(Cee.byteArray("v"), `static const uint8_t v[] = { 0x00, SOME_MACRO };`)
      )
      assert.include(error.message, "SOME_MACRO")
    }))

  it.effect("refuses a name the file declares twice with different contents", () =>
    Effect.gen(function*() {
      const source = [
        `static const uint8_t v[] = { 0x00 };`,
        `static const uint8_t v[] = { 0x01 };`
      ].join("\n")
      const error = yield* Effect.flip(decode(Cee.byteArray("v"), source))
      assert.include(error.message, "different contents")
    }))

  it.effect("accepts a name declared twice with the same contents", () =>
    Effect.gen(function*() {
      // The ordinary preprocessor-guard case: two arms, one value. That is not
      // an ambiguity and refusing it would make the reader useless on headers
      // that are perfectly clear.
      const source = [
        `static const uint8_t v[] = { 0x00, 0x01 };`,
        `static const uint8_t v[] = { 0, 1 };`
      ].join("\n")
      assert.deepStrictEqual(Array.from(yield* decode(Cee.byteArray("v"), source)), [0, 1])
    }))

  it.effect("round-trips through the declaration it writes", () =>
    Effect.gen(function*() {
      const codec = Cee.byteArray("v")
      const bytes = Uint8Array.from(Array.from({ length: 40 }, (_, index) => index * 6))
      const written = yield* Schema.encodeEffect(codec)(bytes)

      // The written form wraps, so this also checks that a line break inside
      // the braces is not a boundary the reader stops at.
      assert.deepStrictEqual(yield* decode(codec, written), bytes)
    }))
})
