// The first request, asserted as the exact bytes that go on the wire.
//
// M1 has no cryptography in it and no randomness, so there is nothing here to
// approximate: the message either is those nine bytes or it is not. The
// expected values are written out from the two rules that produce them — one
// byte of type, one of length, then the value, and flags little-endian with
// trailing zeros dropped — rather than from what the implementation happens to
// emit, which is the only way this test can catch the implementation being
// wrong.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { PairingFlag } from "../../../src/Generated/index.ts"
import { m1 } from "../../../src/PairSetup/Controller/M1.ts"

describe("m1", () => {
  it.effect("is State 1 and Method PairSetup, and nothing else", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* m1({ flags: [] }),
        Uint8Array.of(
          // kTLVType_State, one byte, 1.
          0x06,
          0x01,
          0x01,
          // kTLVType_Method, one byte, kHAPPairingMethod_PairSetup.
          0x00,
          0x01,
          0x00
        )
      )
    }))

  it.effect("omits the flags item entirely rather than writing an empty one", () =>
    Effect.gen(function*() {
      // Not a saving of two bytes. An empty item leaves the ADK with
      // `flagsPresent = true` and a value of zero, which is a different request
      // from one that never mentioned flags.
      const request = yield* m1({ flags: [] })
      assert.strictEqual(request.length, 6)
    }))

  it.effect("writes Transient as a one-byte flags item", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* m1({ flags: [PairingFlag.Transient] }),
        Uint8Array.of(0x06, 0x01, 0x01, 0x00, 0x01, 0x00, 0x13, 0x01, 0x10)
      )
    }))

  it.effect("writes Split as four bytes, little-endian", () =>
    Effect.gen(function*() {
      // 0x01000000 written the other way round is 0x00000001, which the ADK
      // logs as an unrecognised flag and ignores — a request that succeeds and
      // does something else.
      assert.deepStrictEqual(
        yield* m1({ flags: [PairingFlag.Split] }),
        Uint8Array.of(0x06, 0x01, 0x01, 0x00, 0x01, 0x00, 0x13, 0x04, 0x00, 0x00, 0x00, 0x01)
      )
    }))

  it.effect("combines the flags into one item", () =>
    Effect.gen(function*() {
      // The transient-then-full flow asks for both at once; two flags items
      // would leave the ADK reading whichever came first.
      assert.deepStrictEqual(
        yield* m1({ flags: [PairingFlag.Transient, PairingFlag.Split] }),
        Uint8Array.of(0x06, 0x01, 0x01, 0x00, 0x01, 0x00, 0x13, 0x04, 0x10, 0x00, 0x00, 0x01)
      )
    }))

  it.effect("does not depend on the order the flags were listed in", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* m1({ flags: [PairingFlag.Split, PairingFlag.Transient] }),
        yield* m1({ flags: [PairingFlag.Transient, PairingFlag.Split] })
      )
    }))
})
