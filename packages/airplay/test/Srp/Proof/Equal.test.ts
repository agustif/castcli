// Comparing proofs.
//
// Timing is not asserted here — a timing assertion in a JIT-compiled language
// on a shared runner measures the runner, not the code, and would fail at
// random. What is asserted is the observable behaviour: it answers correctly,
// including for the inputs a naive comparison gets wrong.

import { assert, describe, it } from "@effect/vitest"
import { equal } from "../../../src/Srp/Proof/Equal.ts"

describe("equal", () => {
  it("accepts identical values", () => {
    assert.isTrue(equal(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3])))
  })

  it("rejects a difference in the last octet", () => {
    // The case an early-exit comparison answers fastest and this one answers
    // in the same time as any other.
    assert.isFalse(equal(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 4])))
  })

  it("rejects a difference in the first octet", () => {
    assert.isFalse(equal(Uint8Array.from([9, 2, 3]), Uint8Array.from([1, 2, 3])))
  })

  it("rejects a prefix", () => {
    // Length is checked first, so a truncated proof cannot pass by matching as
    // far as it goes.
    assert.isFalse(equal(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3])))
  })

  it("accepts two empty values", () => {
    assert.isTrue(equal(new Uint8Array(0), new Uint8Array(0)))
  })

  it("does not confuse a high bit with a difference", () => {
    // The accumulator is an OR of XORs. A signed-shift mistake in it would
    // make 0x80 vs 0x80 look like a difference, or 0xff vs 0x7f look like a
    // match.
    assert.isTrue(equal(Uint8Array.from([0x80, 0xff]), Uint8Array.from([0x80, 0xff])))
    assert.isFalse(equal(Uint8Array.from([0xff]), Uint8Array.from([0x7f])))
  })
})
