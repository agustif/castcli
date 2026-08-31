// Binary plist encoder/decoder for AirPlay using the npm `plist` package.
// Apple TV /play wants application/x-apple-binary-plist, not XML.

import { buildBinary, parseBinary } from "plist"
import type { PlistValue as LibPlistValue } from "plist"

export type PlistValue = LibPlistValue
export type PlistDict = { [key: string]: PlistValue }
export type PlistArray = ReadonlyArray<PlistValue>

const toStandardUint8Array = (value: PlistValue): PlistValue => {
  if (value instanceof Buffer) {
    return new Uint8Array(value)
  }
  if (value instanceof Uint8Array) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(toStandardUint8Array)
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const result: PlistDict = {}
    for (const [k, v] of Object.entries(value)) {
      result[k] = toStandardUint8Array(v)
    }
    return result
  }
  return value
}

export const encode = (value: PlistValue): Uint8Array => {
  const buffer = buildBinary(value)
  return new Uint8Array(buffer)
}

export const decode = (data: Uint8Array): PlistValue => {
  const buffer = Buffer.from(data)
  const parsed = parseBinary(buffer)
  return toStandardUint8Array(parsed)
}
