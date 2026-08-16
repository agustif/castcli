// H(), against a published digest and against its own concatenation rule.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Encoding } from "effect"
import { NodeServices } from "@effect/platform-node"
import { BYTES, hash, utf8 } from "../../src/Srp/Hash.ts"

/**
 * SHA-512("abc"), from `packages/airplay/vendor/HAPCryptoTest.c`'s own
 * `sha512_hash` — the same constant Apple checks its backend against.
 *
 * Worth having even though nobody suspects Node's SHA-512 of being wrong: it
 * is the assertion that the `Crypto` service is wired to SHA-512 at all, and a
 * layer supplying SHA-256 or the identity function would otherwise sail
 * through every other test in this directory, because those tests only ever
 * compare one derivation against another.
 */
const ABC = "ddaf35a193617abacc417349ae204131" +
  "12e6fa4e89a97ea20a9eeee64b55d39a" +
  "2192992a274fc1a836ba3c23a3feebbd" +
  "454d4423643ce80e2a9ac94fa54ca49f"

describe("hash", () => {
  it.effect("is SHA-512", () =>
    Effect.gen(function*() {
      const digest = yield* hash(utf8("abc"))
      assert.strictEqual(Encoding.encodeHex(digest), ABC)
      assert.strictEqual(digest.length, BYTES)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("concatenates its arguments with nothing between them", () =>
    Effect.gen(function*() {
      // The property every formula in SRP depends on: the fields run together
      // with no separators and no lengths. A separator quietly inserted here
      // would break interoperability with every real accessory and with
      // nothing else in this test suite.
      const split = yield* hash(utf8("ab"), utf8("c"))
      const whole = yield* hash(utf8("abc"))
      assert.deepStrictEqual(split, whole)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("hashes nothing at all rather than refusing to", () =>
    Effect.gen(function*() {
      const digest = yield* hash()
      assert.strictEqual(digest.length, BYTES)
    }).pipe(Effect.provide(NodeServices.layer)))
})

describe("utf8", () => {
  it("encodes the separator SRP's password hash uses", () => {
    assert.deepStrictEqual(utf8(":"), Uint8Array.from([0x3a]))
  })
})
