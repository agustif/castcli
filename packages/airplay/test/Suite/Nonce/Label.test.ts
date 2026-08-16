// The labelled nonce, byte for byte.
//
// There is no published vector for this — it is HAP's own construction — so the
// check is against the vendored implementation's behaviour: `HAPPairingPairSetup.c`
// passes an eight-character string and `sizeof nonce - 1` to a ChaCha20-Poly1305
// call whose nonce buffer is twelve bytes, so the twelve bytes that reach the
// cipher are four zeros followed by the ASCII of the label. That is what is
// asserted here, spelled out rather than computed, because a test that built the
// expectation the same way the code does would prove only that the code is
// deterministic.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Encoding } from "effect"
import * as Nonce from "../../../src/Suite/Nonce/index.ts"

describe("Nonce.label", () => {
  it.effect("is four zero bytes and then the label in ASCII", () =>
    Effect.gen(function*() {
      const nonce = yield* Nonce.label("PS-Msg05")
      // 50 53 2d 4d 73 67 30 35 is "PS-Msg05".
      assert.strictEqual(Encoding.encodeHex(nonce.bytes), "0000000050532d4d73673035")
    }))

  it.effect("gives each pairing message a different nonce", () =>
    Effect.gen(function*() {
      // Every message of an exchange is sealed under the same derived key, so
      // two messages sharing a nonce would leak the exclusive-or of their
      // plaintexts. The labels are what prevent it.
      const fifth = yield* Nonce.label("PS-Msg05")
      const sixth = yield* Nonce.label("PS-Msg06")
      assert.notStrictEqual(
        Encoding.encodeHex(fifth.bytes),
        Encoding.encodeHex(sixth.bytes)
      )
    }))

  it.effect("refuses a label that is not eight characters", () =>
    Effect.gen(function*() {
      // A short label would be zero-padded into a nonce that is well-formed,
      // unique and agrees with nothing on the other end — a bug whose only
      // symptom is an authentication failure several messages later.
      const short = yield* Effect.flip(Nonce.label("PS-Msg"))
      assert.strictEqual(short._tag, "PlatformError")
      const long = yield* Effect.flip(Nonce.label("PS-Msg0555"))
      assert.strictEqual(long._tag, "PlatformError")
    }))

  it.effect("refuses a label whose characters are not one byte each", () =>
    Effect.gen(function*() {
      // Eight characters, nine bytes. A length check written against the
      // string rather than its encoding would let this through, and the nonce it
      // produced would be the wrong length before it was the wrong value.
      const error = yield* Effect.flip(Nonce.label("PS-Msg0é"))
      assert.strictEqual(error._tag, "PlatformError")
    }))
})
