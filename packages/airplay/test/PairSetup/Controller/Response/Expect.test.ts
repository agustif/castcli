// The State byte, which is all that tells the six messages apart.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Result } from "effect"
import { TlvType } from "../../../../src/Generated/index.ts"
import type { Item } from "../../../../src/Tlv8/index.ts"
import { expectState } from "../../../../src/PairSetup/Controller/Response/Expect.ts"

const item = (type: number, ...value: ReadonlyArray<number>): Item => ({
  type,
  value: Uint8Array.from(value)
})

describe("expectState", () => {
  it.effect("accepts the message it was expecting", () =>
    Effect.gen(function*() {
      yield* expectState({ items: [item(TlvType.State, 4)], step: "M4", state: 4 })
    }))

  it.effect("rejects a message from another step and says which one arrived", () =>
    Effect.gen(function*() {
      // A replayed M2 read as an M6 is the case this exists for: both are
      // well-formed messages and the items of one are simply not the items of
      // the other.
      const outcome = yield* Effect.result(
        expectState({ items: [item(TlvType.State, 2)], step: "M6", state: 6 })
      )
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure._tag : "",
        "PairSetupUnexpectedState"
      )
      assert.deepStrictEqual(
        Result.isFailure(outcome) ? outcome.failure.received : Option.none(),
        Option.some(2)
      )
    }))

  it.effect("reports an absent State item as absent rather than as some number", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(
        expectState({ items: [item(TlvType.Salt, 1)], step: "M2", state: 2 })
      )
      assert.deepStrictEqual(
        Result.isFailure(outcome) ? outcome.failure.received : Option.some(0),
        Option.none()
      )
    }))

  it.effect("will not read a multi-byte State item as its first byte", () =>
    Effect.gen(function*() {
      // HAP writes exactly one byte and refuses any other length. Taking the
      // first byte of a longer item would turn a malformed message into a
      // plausible small integer and let the exchange continue.
      const outcome = yield* Effect.result(
        expectState({ items: [item(TlvType.State, 2, 0)], step: "M2", state: 2 })
      )
      assert.isTrue(Result.isFailure(outcome), "a two-byte State item was accepted")
    }))
})
