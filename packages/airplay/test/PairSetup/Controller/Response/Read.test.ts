// The order of the three checks, which is the only thing this file adds.
//
// Each check is tested beside its own implementation; what is asserted here is
// that a message failing two of them is reported as the one that tells a caller
// something. A refusal is also a message with the wrong items in it and, for a
// device that numbers its error response differently, a message from the wrong
// step — so a reader that checked in any other order would answer "no Proof
// item" or "expected State 4" to a device that plainly said "wrong setup code".

import { assert, describe, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { PairingError, TlvType } from "../../../../src/Generated/index.ts"
import { Items } from "../../../../src/Tlv8/index.ts"
import { read } from "../../../../src/PairSetup/Controller/Response/Read.ts"

const payload = (...items: ReadonlyArray<readonly [number, ReadonlyArray<number>]>) =>
  Schema.encodeEffect(Items)(
    items.map(([type, value]) => ({ type, value: Uint8Array.from(value) }))
  )

const tagOf = (outcome: Result.Result<unknown, { readonly _tag: string }>): string =>
  Result.isFailure(outcome) ? outcome.failure._tag : "no failure"

describe("read", () => {
  it.effect("returns the items of a well-formed message for the expected step", () =>
    Effect.gen(function*() {
      const bytes = yield* payload([TlvType.State, [2]], [TlvType.Salt, [1, 2, 3]])
      const items = yield* read({ bytes, step: "M2", state: 2 })
      assert.strictEqual(items.length, 2)
    }))

  it.effect("rejoins a fragmented value, so a long public key arrives whole", () =>
    Effect.gen(function*() {
      // The reason decoding goes through the payload codec rather than a reader
      // of its own: the accessory's SRP public key is 384 bytes and arrives as
      // two items, and a caller handed the first of them would verify a proof
      // against the first 255 bytes of a key.
      const key = Array.from({ length: 384 }, (_, index) => index & 0xff)
      const bytes = yield* payload([TlvType.State, [2]], [TlvType.PublicKey, key])
      const items = yield* read({ bytes, step: "M2", state: 2 })
      assert.strictEqual(
        items.find((item) => item.type === TlvType.PublicKey)?.value.length,
        384
      )
    }))

  it.effect("reports a refusal as a refusal even though its items are missing", () =>
    Effect.gen(function*() {
      const bytes = yield* payload(
        [TlvType.State, [4]],
        [TlvType.Error, [PairingError.Authentication]]
      )
      const outcome = yield* Effect.result(read({ bytes, step: "M4", state: 4 }))
      assert.strictEqual(tagOf(outcome), "PairSetupWrongSetupCode")
    }))

  it.effect("reports a refusal ahead of a State that disagrees", () =>
    Effect.gen(function*() {
      // The ADK happens to number its error response the same as the response
      // it replaces, so this combination should not arise from it — which is
      // exactly why the order has to be right for the devices that are not it.
      const bytes = yield* payload([TlvType.State, [2]], [TlvType.Error, [PairingError.Busy]])
      const outcome = yield* Effect.result(read({ bytes, step: "M4", state: 4 }))
      assert.strictEqual(tagOf(outcome), "PairSetupAccessoryRefused")
    }))

  it.effect("rejects a payload that ends in the middle of an item", () =>
    Effect.gen(function*() {
      // A truncated message loses its tail, and the tail is where the proof and
      // the signature are — the items that would have failed. Everything before
      // them decodes perfectly.
      const outcome = yield* Effect.result(
        read({ bytes: Uint8Array.of(TlvType.State, 4, 2), step: "M2", state: 2 })
      )
      assert.strictEqual(tagOf(outcome), "SchemaError")
    }))
})
