// The counted nonce, with the endianness written out.
//
// The expected bytes are literals rather than anything computed. Endianness is
// the one thing this construction can get wrong, and a test that derived its
// expectation with the same `DataView` call the code uses would agree with a
// big-endian implementation just as happily.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Encoding } from "effect"
import * as Nonce from "../../../src/Suite/Nonce/index.ts"

describe("Nonce.counter", () => {
  it.effect("is four zero bytes and then the count, least significant first", () =>
    Effect.gen(function*() {
      const first = yield* Nonce.counter(0n)
      assert.strictEqual(Encoding.encodeHex(first.bytes), "000000000000000000000000")

      // 1 sits in the fifth byte, not the twelfth. Big-endian would put it last,
      // and the difference does not show up until a real receiver refuses the
      // first frame after a pairing that appeared to succeed.
      const second = yield* Nonce.counter(1n)
      assert.strictEqual(Encoding.encodeHex(second.bytes), "000000000100000000000000")

      // A count whose bytes are all distinct, so a reversed or rotated
      // implementation cannot coincide with this by symmetry.
      const later = yield* Nonce.counter(0x0807060504030201n)
      assert.strictEqual(Encoding.encodeHex(later.bytes), "000000000102030405060708")
    }))

  it.effect("counts past what a double can hold", () =>
    Effect.gen(function*() {
      // 2^53 and 2^53 + 1 are the same `number` and different `bigint`s. If the
      // counter were a `number`, a long session would seal two frames under one
      // nonce, which for a stream cipher loses both plaintexts and the
      // authentication key with them.
      const boundary = yield* Nonce.counter(9007199254740992n)
      const next = yield* Nonce.counter(9007199254740993n)
      assert.notStrictEqual(
        Encoding.encodeHex(boundary.bytes),
        Encoding.encodeHex(next.bytes)
      )
    }))

  it.effect("refuses a count that is not a 64-bit unsigned integer", () =>
    Effect.gen(function*() {
      // `setBigUint64` wraps silently on both of these — -1 becomes the largest
      // possible counter, and 2^64 becomes zero, which is a nonce the session
      // already used for its first frame.
      const negative = yield* Effect.flip(Nonce.counter(-1n))
      assert.strictEqual(negative._tag, "PlatformError")
      const overflow = yield* Effect.flip(Nonce.counter(1n << 64n))
      assert.strictEqual(overflow._tag, "PlatformError")
    }))
})
