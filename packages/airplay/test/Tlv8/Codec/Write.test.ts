// Writing: type, length, value, and nothing else.

import { assert, describe, it } from "@effect/vitest"
import { write } from "../../../src/Tlv8/Codec/Write.ts"

describe("Tlv8.Codec.write", () => {
  it("writes each fragment as its type, its length, then its bytes", () => {
    assert.deepStrictEqual(
      Array.from(write([
        { type: 6, value: new Uint8Array([1]) },
        { type: 3, value: new Uint8Array([0xaa, 0xbb]) }
      ])),
      [6, 1, 1, 3, 2, 0xaa, 0xbb]
    )
  })

  it("writes a zero-length item as its two header bytes", () => {
    // kTLVType_Separator is exactly this and nothing else.
    assert.deepStrictEqual(Array.from(write([{ type: 255, value: new Uint8Array(0) }])), [255, 0])
  })

  it("writes nothing for no items", () => {
    assert.strictEqual(write([]).length, 0)
  })
})
