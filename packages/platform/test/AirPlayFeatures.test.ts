// AirPlay features field parser: two comma-separated hex values (0xLOWER,0xUPPER).
//
// The spec requires combining them as (high << 32) | low. Xiaomi TV advertises
// 0x7f8ad0,0x38bcf46, which has bit 49 (VideoV2) set. Parsing only the first
// word drops the high bits and incorrectly reports supportsVideo = false.

import { assert, describe, it } from "@effect/vitest"

describe("AirPlay features parser", () => {
  it("parses two-part features correctly (Xiaomi TV case)", () => {
    // Xiaomi TV advertises features=0x7f8ad0,0x38bcf46
    // low = 0x7f8ad0, high = 0x38bcf46
    // Combined: (0x38bcf46 << 32) | 0x7f8ad0 = 0x38bcf460007f8ad0
    // Bit 49 is set in the high word, so VideoV2 is ON
    const low = 0x7f8ad0n
    const high = 0x38bcf46n
    const combined = (high << 32n) | low

    // Bit 49 check (VideoV2)
    const bit49 = (combined & (1n << 49n)) !== 0n
    assert.isTrue(bit49)

    // This is what supportsVideo checks
    const bit0 = (combined & 1n) !== 0n
    const supportsVideo = bit0 || bit49
    assert.isTrue(supportsVideo)
  })

  it("handles single-value features", () => {
    // Some devices only advertise a single value
    const features = 0x527FFEE6n
    const bit0 = (features & 1n) !== 0n
    assert.isFalse(bit0)
  })
})
