// PAD(), including the case Apple's vectors cannot reach.
//
// Every number in `HAPCryptoTest.c` has its top octet set, so padded and
// minimal encodings are the same bytes there and no vector distinguishes them.
// These are the assertions that actually exercise the difference.

import { assert, describe, it } from "@effect/vitest"
import { pad } from "../../../src/Srp/Math/Pad.ts"

describe("pad", () => {
  it("left-extends with zeros", () => {
    assert.deepStrictEqual(pad(Uint8Array.from([0x05]), 4), Uint8Array.from([0, 0, 0, 5]))
  })

  it("leaves a value that is already the full width alone", () => {
    const full = Uint8Array.from([1, 2, 3, 4])
    assert.deepStrictEqual(pad(full, 4), full)
  })

  it("copies rather than aliasing", () => {
    // A returned view onto the caller's buffer would let a later mutation
    // change a value that has already been hashed, which is the kind of bug
    // that only appears under concurrency.
    const source = Uint8Array.from([1, 2, 3, 4])
    const padded = pad(source, 4)
    assert.notStrictEqual(padded.buffer, source.buffer)
  })

  it("pads to the group width even when that is 383 zeros", () => {
    // The shape of the real case: g = 5 inside the multiplier.
    const padded = pad(Uint8Array.from([0x05]), 384)
    assert.strictEqual(padded.length, 384)
    assert.strictEqual(padded[383], 5)
    assert.isTrue(padded.slice(0, 383).every((octet) => octet === 0))
  })

  it("keeps the low-order octets when the input is too wide", () => {
    // Documented behaviour rather than desirable behaviour: it should never
    // happen, because everything is reduced modulo N first. Pinned so that if
    // it ever does happen the result is the arithmetic one — the value modulo
    // 2^(8*width) — and not a silent zero-fill that looks like a valid small
    // number.
    assert.deepStrictEqual(pad(Uint8Array.from([1, 2, 3, 4]), 2), Uint8Array.from([3, 4]))
  })
})
