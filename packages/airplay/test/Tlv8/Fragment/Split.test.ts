// Splitting, checked at the boundary rather than in the middle.
//
// A 512-byte value is the easy case: any implementation that chunks at all
// gets it. The cases that separate implementations are the ones where the
// value divides evenly — 0 bytes and 255 bytes — because those are the ones
// where an extra empty fragment looks like a bug.

import { assert, describe, it } from "@effect/vitest"
import { Crypto, Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { split } from "../../../src/Tlv8/Fragment/Split.ts"

const lengths = (item: { readonly type: number; readonly value: Uint8Array }) =>
  split(item).map((fragment) => fragment.value.length)

describe("Tlv8.Fragment.split", () => {
  it.effect("cuts a long value into 255-byte fragments and a remainder", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const value = yield* crypto.randomBytes(512)
      const fragments = split({ type: 3, value })

      assert.deepStrictEqual(fragments.map((f) => f.value.length), [255, 255, 2])
      assert.isTrue(fragments.every((f) => f.type === 3), "a fragment changed type")

      // The bytes, in order, are the value: a reader that concatenates gets
      // back exactly what was split.
      const rejoined = Uint8Array.from(fragments.flatMap((f) => Array.from(f.value)))
      assert.deepStrictEqual(Array.from(rejoined), Array.from(value))
    }).pipe(Effect.provide(NodeServices.layer)))

  it("ends a value of exactly 255 bytes with an empty fragment", () => {
    // Without the empty fragment, the reader is still mid-run when it reaches
    // the next item, and merges it if the types match.
    assert.deepStrictEqual(lengths({ type: 1, value: new Uint8Array(255) }), [255, 0])
    assert.deepStrictEqual(lengths({ type: 1, value: new Uint8Array(510) }), [255, 255, 0])
  })

  it("writes an empty value as one empty fragment, not as nothing", () => {
    // kTLVType_Separator is a zero-length item and means everything by being
    // present. Emitting no fragments would delete it.
    assert.deepStrictEqual(lengths({ type: 255, value: new Uint8Array(0) }), [0])
  })

  it("leaves a value that already fits as a single fragment", () => {
    assert.deepStrictEqual(lengths({ type: 2, value: new Uint8Array(254) }), [254])
    assert.deepStrictEqual(lengths({ type: 2, value: new Uint8Array(1) }), [1])
  })

  it("copies, so a fragment does not alias the value it came from", () => {
    // A shared view would make a fragment change under a caller that reuses
    // its buffer — which a caller assembling several messages does.
    const value = new Uint8Array([1, 2, 3])
    const fragment = split({ type: 4, value })[0]?.value ?? new Uint8Array(0)
    value.set([9], 0)
    assert.strictEqual(fragment[0], 1)
  })
})
