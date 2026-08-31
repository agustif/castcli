import { assert, describe, it } from "@effect/vitest"
import { Ipv4 } from "@castcli/domain"
import { AirPlayPairing } from "../src/State.ts"

const toUint8Array = (obj: Record<string, number>): Uint8Array => {
  const arr = Object.values(obj)
  return new Uint8Array(arr)
}

describe("AirPlayPairing serialization", () => {
  it("round-trips Uint8Array fields through JSON", () => {
    const original = new AirPlayPairing({
      deviceIp: Ipv4.make("192.168.1.24"),
      deviceId: "AA:BB:CC:DD:EE:FF",
      controllerIdentifier: "test-controller",
      controllerPublicKey: new Uint8Array([1, 2, 3, 4, 5]),
      controllerPrivateKey: new Uint8Array([10, 20, 30, 40, 50]),
      accessoryIdentifier: new Uint8Array([100, 101, 102]),
      accessoryPublicKey: new Uint8Array([200, 201, 202, 203])
    })

    const jsonString = JSON.stringify(original)
    // eslint-disable-next-line castcli/no-json-parse -- Testing serialization round-trip
    const parsed = JSON.parse(jsonString)
    
    const decoded = new AirPlayPairing({
      deviceIp: Ipv4.make(parsed.deviceIp),
      deviceId: parsed.deviceId,
      controllerIdentifier: parsed.controllerIdentifier,
      controllerPublicKey: toUint8Array(parsed.controllerPublicKey),
      controllerPrivateKey: toUint8Array(parsed.controllerPrivateKey),
      accessoryIdentifier: toUint8Array(parsed.accessoryIdentifier),
      accessoryPublicKey: toUint8Array(parsed.accessoryPublicKey)
    })
    
    assert.isTrue(jsonString.length > 0, "JSON should be generated")
    assert.isTrue(jsonString.includes('"0":'), "JSON serializes Uint8Array as object notation")
    assert.strictEqual(decoded.deviceIp, original.deviceIp)
    assert.strictEqual(decoded.deviceId, original.deviceId)
    assert.strictEqual(decoded.controllerIdentifier, original.controllerIdentifier)
    
    assert.deepStrictEqual(
      Array.from(decoded.controllerPublicKey),
      Array.from(original.controllerPublicKey)
    )
    assert.deepStrictEqual(
      Array.from(decoded.controllerPrivateKey),
      Array.from(original.controllerPrivateKey)
    )
    assert.deepStrictEqual(
      Array.from(decoded.accessoryIdentifier),
      Array.from(original.accessoryIdentifier)
    )
    assert.deepStrictEqual(
      Array.from(decoded.accessoryPublicKey),
      Array.from(original.accessoryPublicKey)
    )
  })
})
