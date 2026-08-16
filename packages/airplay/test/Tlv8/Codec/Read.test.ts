// Reading, and in particular refusing to read past the end.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { read } from "../../../src/Tlv8/Codec/Read.ts"

describe("Tlv8.Codec.read", () => {
  it.effect("reads type, length and value, in order, leaving fragments alone", () =>
    Effect.gen(function*() {
      // 06 01 01 | 03 02 AA BB — a State item and a two-byte PublicKey.
      const items = yield* read(new Uint8Array([6, 1, 1, 3, 2, 0xaa, 0xbb]))
      assert.deepStrictEqual(items.map((item) => item.type), [6, 3])
      assert.deepStrictEqual(Array.from(items[1]?.value ?? new Uint8Array(0)), [0xaa, 0xbb])
    }))

  it.effect("reads an empty payload as no items", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* read(new Uint8Array(0)), [])
    }))

  it.effect("reads a zero-length item rather than skipping it", () =>
    Effect.gen(function*() {
      const items = yield* read(new Uint8Array([0xff, 0]))
      assert.strictEqual(items.length, 1)
      assert.strictEqual(items[0]?.value.length, 0)
    }))

  it.effect("fails when a length byte promises more bytes than remain", () =>
    Effect.gen(function*() {
      // Catches: a reader that clamps the slice to the end of the buffer, or
      // that stops silently and returns what it has. A pairing message that
      // loses its tail loses the Proof — the item that would have failed to
      // verify — and everything before it reads perfectly, so returning the
      // prefix hands the caller a message with the "no" removed.
      const exit = yield* Effect.exit(read(new Uint8Array([4, 64, 1, 2, 3])))
      assert.strictEqual(exit._tag, "Failure", "a payload cut mid-value decoded")
    }))

  it.effect("fails on a type byte with no length byte after it", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(read(new Uint8Array([6, 1, 1, 3])))
      assert.strictEqual(exit._tag, "Failure", "a payload cut mid-header decoded")
    }))

  it.effect("copies values out rather than viewing into the payload", () =>
    Effect.gen(function*() {
      const payload = new Uint8Array([6, 1, 1])
      const items = yield* read(payload)
      payload.set([9], 2)
      // A subarray here would have changed the decoded item under the caller,
      // which for a nonce or a key surfaces as a decryption failure far away.
      assert.strictEqual(items[0]?.value[0], 1)
    }))
})
