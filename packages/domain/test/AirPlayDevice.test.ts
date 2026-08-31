// Features is a 64-bit mask advertised as two hex words. Dropping the high
// word hides Video V2 (bit 49) — the Xiaomi on this LAN has bit 0 off and
// bit 49 on, and was listed as audio-only until the parser joined both words.

import { assert, describe, it } from "@effect/vitest"
import { AirPlayDevice, parseAirPlayFeatures } from "../src/AirPlayDevice.ts"
import { Ipv4, Port } from "../src/Brands.ts"

describe("parseAirPlayFeatures", () => {
  it("joins 0xLOWER,0xUPPER into a 64-bit mask", () => {
    // Televisor Xiaomi 100: bit 0 off, bit 49 (Video V2) on.
    const features = parseAirPlayFeatures("0x7f8ad0,0x38bcf46")
    assert.isTrue(features !== undefined)
    assert.strictEqual(features, 255525703439583952n)
    assert.strictEqual((features! & 1n) === 0n, true)
    assert.strictEqual((features! & (1n << 49n)) !== 0n, true)
  })

  it("keeps a single-word mask in the low 32 bits", () => {
    const features = parseAirPlayFeatures("0x1")
    assert.strictEqual(features, 1n)
  })

  it("returns undefined for junk rather than throwing", () => {
    assert.strictEqual(parseAirPlayFeatures("not-hex"), undefined)
  })
})

describe("AirPlayDevice.supportsVideo", () => {
  const device = (features: bigint | undefined) =>
    new AirPlayDevice({
      name: "tv",
      ip: Ipv4.make("192.168.1.24"),
      port: Port.make(7000),
      features
    })

  it("is true when only Video V2 (bit 49) is set", () => {
    assert.isTrue(device(1n << 49n).supportsVideo)
  })

  it("is true when only Video V1 (bit 0) is set", () => {
    assert.isTrue(device(1n).supportsVideo)
  })

  it("is false when the high word was dropped (Xiaomi low word alone)", () => {
    assert.isFalse(device(0x7f8ad0n).supportsVideo)
  })

  it("is true for the joined Xiaomi mask", () => {
    assert.isTrue(device(parseAirPlayFeatures("0x7f8ad0,0x38bcf46")).supportsVideo)
  })
})
