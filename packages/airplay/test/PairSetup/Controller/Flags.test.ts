// The flags field, against the two functions in the ADK that define it.
//
// `HAPPairingGetNumBytes` says how many bytes a value takes and
// `HAPPairingReadFlags` says how they are read; between them they fix the
// encoding as little-endian with trailing zeros dropped. Both of the values HAP
// defines are checked here because they exercise opposite ends of the rule:
// `Transient` is 0x10 and fits in one byte, `Split` is 0x01000000 and needs all
// four, and an implementation that got the byte order wrong would still pass a
// test that only used one of them.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { PairingFlag } from "../../../src/Generated/index.ts"
import { Flags } from "../../../src/PairSetup/Controller/Flags.ts"

const encode = Schema.encodeEffect(Flags)
const decode = Schema.decodeUnknownEffect(Flags)

describe("encoding", () => {
  it.effect("writes Transient as one byte", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* encode(PairingFlag.Transient),
        Uint8Array.of(0x10)
      )
    }))

  it.effect("writes Split little-endian, which is four bytes ending in one", () =>
    Effect.gen(function*() {
      // The assertion that catches a big-endian writer. Written the other way
      // round this is 0x01000000 read as 0x00000001, which HAP logs as an
      // unrecognised flag and ignores — so the exchange succeeds and does not
      // do what was asked.
      assert.deepStrictEqual(
        yield* encode(PairingFlag.Split),
        Uint8Array.of(0x00, 0x00, 0x00, 0x01)
      )
    }))

  it.effect("writes both together in four bytes", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* encode(PairingFlag.Transient | PairingFlag.Split),
        Uint8Array.of(0x10, 0x00, 0x00, 0x01)
      )
    }))

  it.effect("writes zero as no bytes at all", () =>
    Effect.gen(function*() {
      // `HAPPairingGetNumBytes(0)` is zero, and this is what lets M1 decide
      // whether to write the item by asking the encoder rather than by testing
      // the number a second time.
      assert.strictEqual((yield* encode(0)).length, 0)
    }))

  it.effect("refuses a value wider than the field", () =>
    Effect.gen(function*() {
      // Without the bound the encoder would silently write the low 32 bits: a
      // different set of flags, and no complaint.
      const outcome = yield* Effect.result(encode(2 ** 33))
      assert.isTrue(Result.isFailure(outcome), "a 33-bit flags value was accepted")
    }))
})

describe("decoding", () => {
  it.effect("reads the bytes back as the value that wrote them", () =>
    Effect.gen(function*() {
      assert.strictEqual(
        yield* decode(Uint8Array.of(0x10, 0x00, 0x00, 0x01)),
        PairingFlag.Transient | PairingFlag.Split
      )
    }))

  it.effect("reads a value in the top bit as a positive number", () =>
    Effect.gen(function*() {
      // The reason the implementation multiplies rather than shifting. `1 << 31`
      // in JavaScript is negative, so a flag HAP has not defined yet — but a
      // later specification might — would come out as -2147483648 and compare
      // equal to nothing.
      assert.strictEqual(
        yield* decode(Uint8Array.of(0x00, 0x00, 0x00, 0x80)),
        2 ** 31
      )
    }))

  it.effect("reads an absent field, written as no bytes, as no flags", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* decode(new Uint8Array()), 0)
    }))

  it.effect("refuses more than four bytes, as the accessory does", () =>
    Effect.gen(function*() {
      // `HAPPairingPairSetupProcessM1` treats a longer flags item as
      // kHAPError_InvalidData and abandons the procedure, so accepting it here
      // would only mean disagreeing about a message already refused.
      const outcome = yield* Effect.result(decode(new Uint8Array(5)))
      assert.isTrue(Result.isFailure(outcome), "a five-byte flags item was accepted")
    }))

  it.effect("normalises trailing zeros, and says so", () =>
    Effect.gen(function*() {
      // Documented rather than desirable: a writer is required to drop them, so
      // the round trip is not the identity on bytes that should never have been
      // written that way.
      assert.deepStrictEqual(
        yield* encode(yield* decode(Uint8Array.of(0x10, 0x00))),
        Uint8Array.of(0x10)
      )
    }))
})
