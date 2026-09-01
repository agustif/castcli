// Features is a 64-bit mask advertised as two hex words. Dropping the high
// word hides Video V2 (bit 49) — the Xiaomi on this LAN has bit 0 off and
// bit 49 on, and was listed as audio-only until the parser joined both words.

import { assert, describe, it } from "@effect/vitest"
import { AirPlayDevice, parseAirPlayFeatures } from "../src/AirPlayDevice.ts"
import { Ipv4, Port } from "../src/Brands.ts"

describe("parseAirPlayFeatures", () => {
  it("joins 0xLOWER,0xUPPER into a 64-bit mask", () => {
    // Televisor Xiaomi 100: bit 0 off, bit 49 (Video V2) on.
    const features = parseAirPlayFeatures("0x7f8ad0,0x38bcf46") ?? 0n
    assert.notStrictEqual(features, 0n)
    assert.strictEqual(features, 255525703439583952n)
    assert.strictEqual((features & 1n) === 0n, true)
    assert.strictEqual((features & (1n << 49n)) !== 0n, true)
  })

  it("keeps a single-word mask in the low 32 bits", () => {
    const features = parseAirPlayFeatures("0x1")
    assert.strictEqual(features, 1n)
  })

  it("returns undefined for junk rather than throwing", () => {
    assert.strictEqual(parseAirPlayFeatures("not-hex"), undefined)
  })
})

const videoDevice = (features: bigint | undefined) =>
  new AirPlayDevice({
    name: "tv",
    ip: Ipv4.make("192.168.1.24"),
    port: Port.make(7000),
    features
  })

describe("AirPlayDevice.supportsVideo", () => {

  it("is true when only Video V2 (bit 49) is set", () => {
    assert.isTrue(videoDevice(1n << 49n).supportsVideo)
  })

  it("is true when only Video V1 (bit 0) is set", () => {
    assert.isTrue(videoDevice(1n).supportsVideo)
  })

  it("is false when the high word was dropped (Xiaomi low word alone)", () => {
    assert.isFalse(videoDevice(0x7f8ad0n).supportsVideo)
  })

  it("is true for the joined Xiaomi mask", () => {
    assert.isTrue(videoDevice(parseAirPlayFeatures("0x7f8ad0,0x38bcf46")).supportsVideo)
  })
})

describe("macOS AirPlay Receiver pairing prelude", () => {
  it("treats Mac15,9 as a Mac receiver that must not POST /pair-pin-start", () => {
    const device = new AirPlayDevice({
      name: "MacBook Pro de Agusti",
      ip: Ipv4.make("192.168.1.123"),
      port: Port.make(7000),
      model: "Mac15,9",
      act: "2"
    })
    assert.isTrue(device.isMacReceiver)
    assert.isFalse(device.wantsPairPinStart)
  })

  it("keeps pair-pin-start for Apple TV", () => {
    const device = new AirPlayDevice({
      name: "Living Room",
      ip: Ipv4.make("192.168.1.10"),
      port: Port.make(7000),
      model: "AppleTV14,1"
    })
    assert.isFalse(device.isMacReceiver)
    assert.isTrue(device.wantsPairPinStart)
  })
})
