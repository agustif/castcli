import { describe, it, expect } from "vitest"
import * as bplist from "../src/bplist.ts"

describe("bplist encoder/decoder", () => {
  it("should encode and decode a simple string", () => {
    const input = "hello"
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toBe("hello")
  })

  it("should encode and decode an integer", () => {
    const input = 42
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toBe(42)
  })

  it("should encode and decode a real number", () => {
    const input = Math.PI
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toBeCloseTo(Math.PI, 5)
  })

  it("should encode and decode boolean values", () => {
    const trueEncoded = bplist.encode(true)
    const trueDecoded = bplist.decode(trueEncoded)
    expect(trueDecoded).toBe(true)

    const falseEncoded = bplist.encode(false)
    const falseDecoded = bplist.decode(falseEncoded)
    expect(falseDecoded).toBe(false)
  })

  it("should encode and decode null", () => {
    const encoded = bplist.encode(null)
    const decoded = bplist.decode(encoded)
    expect(decoded).toBe(null)
  })

  it("should encode and decode data (Uint8Array)", () => {
    const input = new Uint8Array([1, 2, 3, 4, 5])
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toEqual(input)
  })

  it("should encode and decode a simple array", () => {
    const input = ["a", "b", "c"]
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toEqual(["a", "b", "c"])
  })

  it("should encode and decode a simple dict", () => {
    const input = { foo: "bar", baz: 123 }
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toEqual({ foo: "bar", baz: 123 })
  })

  it("should encode and decode nested dicts", () => {
    const input = {
      outer: {
        inner: "value",
        number: 42
      }
    }
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toEqual(input)
  })

  it("should encode and decode nested arrays", () => {
    const input = [["a", "b"], ["c", "d"]]
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toEqual([["a", "b"], ["c", "d"]])
  })

  it("should encode and decode a wrapper with nested data (play-queue scenario)", () => {
    const innerCommand = {
      type: "insertPlayQueueItem",
      item: {
        uuid: "12345678-1234-1234-1234-123456789012",
        mediaType: "file",
        "Content-Location": "http://example.com/video.mp4",
        "Start-Position-Seconds": 10.5
      }
    }
    const innerEncoded = bplist.encode(innerCommand)
    const wrapper = {
      params: {
        data: innerEncoded
      }
    }
    const wrapperEncoded = bplist.encode(wrapper)
    const wrapperDecoded = bplist.decode(wrapperEncoded)
    expect(typeof wrapperDecoded).toBe("object")
    expect(wrapperDecoded).not.toBeNull()
    expect(Array.isArray(wrapperDecoded)).toBe(false)
  })

  it("should round-trip a complex nested structure", () => {
    const input = {
      type: "setProperty",
      property: "isInterestedInDateRange",
      value: true,
      item: {
        uuid: "ABCDEF12-3456-7890-ABCD-EF1234567890"
      }
    }
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toEqual(input)
  })

  it("should handle long strings", () => {
    const input = "a".repeat(300)
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toBe(input)
  })

  it("should handle large arrays", () => {
    const input = Array.from({ length: 100 }, (_, i) => i)
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toEqual(input)
  })

  it("should handle large dicts", () => {
    const input: Record<string, number> = {}
    for (let i = 0; i < 50; i++) {
      input[`key${i}`] = i
    }
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toEqual(input)
  })

  it("should handle mixed types in array", () => {
    const input = ["string", 42, 3.14, true, false, null, new Uint8Array([1, 2, 3])]
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toEqual(input)
  })

  it("should handle mixed types in dict", () => {
    const input = {
      str: "value",
      int: 42,
      real: 3.14,
      bool: true,
      data: new Uint8Array([1, 2, 3]),
      nested: { inner: "value" }
    }
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toEqual(input)
  })

  it("should validate bplist header", () => {
    const badHeader = new TextEncoder().encode("notbplist")
    expect(() => bplist.decode(badHeader)).toThrow("Invalid binary plist")
  })

  it("should handle empty data", () => {
    const input = new Uint8Array([])
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toEqual(new Uint8Array([]))
  })

  it("should encode AirPlay SETUP dict with timingPort", () => {
    const input = {
      deviceID: "AA:BB:CC:DD:EE:FF",
      sessionUUID: "12345678-1234-1234-1234-123456789012",
      sessionCorrelationUUID: "87654321-4321-4321-4321-210987654321",
      timingPort: 54321,
      timingProtocol: "NTP",
      isMultiSelectAirPlay: true,
      groupContainsGroupLeader: false,
      macAddress: "AA:BB:CC:DD:EE:FF",
      model: "iPhone14,3",
      name: "castcli",
      osBuildVersion: "20F66",
      osName: "iPhone OS",
      osVersion: "16.5",
      senderSupportsRelay: false,
      sourceVersion: "960.13.1",
      statsCollectionEnabled: false
    }
    const encoded = bplist.encode(input)
    const decoded = bplist.decode(encoded)
    expect(decoded).toEqual(input)
  })
})
