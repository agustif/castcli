// The group, and the width every PAD() in the protocol is measured against.
//
// The modulus itself is checked for primality in `test/Group3072.test.ts`;
// nothing here repeats that. What is checked here is the thing that file
// cannot: that the width used for padding is derived from the same digits as
// the modulus, so the two can never drift apart.

import { assert, describe, it } from "@effect/vitest"
import * as Group from "../../src/Srp/Group.ts"
import { fromBigInt } from "../../src/Srp/Math/Bytes.ts"

describe("Group.rfc5054", () => {
  it("is 384 octets wide, matching SRP_PRIME_BYTES in HAPCrypto.h", () => {
    assert.strictEqual(Group.rfc5054.byteLength, 384)
  })

  it("has a width that really is the width of its own modulus", () => {
    // The failure this guards against is a group swapped underneath the
    // constant while `byteLength` keeps pointing at the old modulus. Every
    // PAD() in the protocol would then be measured against the wrong number,
    // producing values that are individually well-formed and mutually
    // incompatible.
    assert.strictEqual(fromBigInt(Group.rfc5054.modulus).length, Group.rfc5054.byteLength)
  })

  it("generates with 5", () => {
    assert.strictEqual(Group.rfc5054.generator, 5n)
  })
})

describe("Group.encode", () => {
  it("widens a small value to the full modulus width", () => {
    const encoded = Group.encode(Group.rfc5054, Group.rfc5054.generator)
    assert.strictEqual(encoded.length, 384)
    assert.strictEqual(encoded[383], 5)
  })

  it("leaves a full-width value unchanged", () => {
    assert.deepStrictEqual(
      Group.encode(Group.rfc5054, Group.rfc5054.modulus),
      fromBigInt(Group.rfc5054.modulus)
    )
  })

  it("works in a toy group, which is what makes the padding rules testable", () => {
    // The point of carrying the group as a parameter: here a value with a
    // leading zero octet can be constructed on purpose, which no number in
    // Apple's vectors permits.
    const toy: Group.Group = { modulus: 65_521n, generator: 3n, byteLength: 2 }
    assert.deepStrictEqual(Group.encode(toy, 5n), Uint8Array.from([0x00, 0x05]))
  })
})
