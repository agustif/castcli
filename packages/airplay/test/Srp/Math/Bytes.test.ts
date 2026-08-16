// Byte order, which is stated once in the specifications and assumed forever
// afterwards.
//
// A big-endian/little-endian mistake here would not produce an obvious
// failure. It would produce numbers of the right size that simply do not match
// anyone else's, which is indistinguishable from a wrong password at every
// layer above.

import { assert, describe, it } from "@effect/vitest"
import { fromBigInt, toBigInt } from "../../../src/Srp/Math/Bytes.ts"
import { SrpVectors } from "../../../src/Generated/index.ts"

describe("toBigInt", () => {
  it("reads the first octet as the most significant", () => {
    // The whole of the endianness question, in one assertion. Little-endian
    // would read this as 1.
    assert.strictEqual(toBigInt(Uint8Array.from([0x01, 0x00])), 256n)
  })

  it("ignores leading zeros, which is why padding never affects the arithmetic", () => {
    assert.strictEqual(
      toBigInt(Uint8Array.from([0x00, 0x00, 0x2a])),
      toBigInt(Uint8Array.from([0x2a]))
    )
  })

  it("reads an empty string as zero", () => {
    assert.strictEqual(toBigInt(new Uint8Array(0)), 0n)
  })
})

describe("fromBigInt", () => {
  it("writes the most significant octet first", () => {
    assert.deepStrictEqual(fromBigInt(256n), Uint8Array.from([0x01, 0x00]))
  })

  it("emits no leading zeros", () => {
    // The minimal encoding. Everything that needs a fixed width asks `pad` for
    // it; nothing gets it here by accident.
    assert.deepStrictEqual(fromBigInt(5n), Uint8Array.from([0x05]))
  })

  it("pads an odd digit count up to whole octets", () => {
    // `(4095n).toString(16)` is "fff" — three digits. Emitting those as bytes
    // without the leading zero shifts every octet by a nibble.
    assert.deepStrictEqual(fromBigInt(4095n), Uint8Array.from([0x0f, 0xff]))
  })
})

describe("the pair", () => {
  it("round-trips a real 384-octet value", () => {
    // Apple's verifier: 384 octets with a non-zero top byte, so minimal and
    // padded encodings coincide and the round trip is exact.
    assert.deepStrictEqual(fromBigInt(toBigInt(SrpVectors.v)), SrpVectors.v)
  })
})
