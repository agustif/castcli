// The item schema's one job beyond describing a shape: refusing a type byte
// that is not a byte.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Item } from "../../src/Tlv8/Item.ts"

const decode = Schema.decodeUnknownEffect(Item)

describe("Tlv8.Item", () => {
  it.effect("accepts a type anywhere in the byte range", () =>
    Effect.gen(function*() {
      const item = yield* decode({ type: 255, value: new Uint8Array(0) })
      assert.strictEqual(item.type, 255)
    }))

  it.effect("refuses a type that does not fit in a byte", () =>
    Effect.gen(function*() {
      // 256 would be written as the length-one byte 0, which is
      // kTLVType_Method: the device would answer a Method item it was never
      // sent. There is no length byte to notice, so failing here is the only
      // place this can be caught.
      const overflow = yield* Effect.exit(decode({ type: 256, value: new Uint8Array(0) }))
      assert.strictEqual(overflow._tag, "Failure", "a type of 256 was accepted")

      const negative = yield* Effect.exit(decode({ type: -1, value: new Uint8Array(0) }))
      assert.strictEqual(negative._tag, "Failure", "a type of -1 was accepted")

      const fractional = yield* Effect.exit(decode({ type: 6.5, value: new Uint8Array(0) }))
      assert.strictEqual(fractional._tag, "Failure", "a fractional type was accepted")
    }))

  it("puts no bound on the value, because fragmentation is the wire's problem", () => {
    // A 512-byte public key is one Item and three items on the wire. If this
    // type carried the 255-byte limit, every caller would have to think in
    // fragments and the rejoining rule would have nowhere to live.
    const key: Item = { type: 3, value: new Uint8Array(512) }
    assert.strictEqual(key.value.length, 512)
  })
})
