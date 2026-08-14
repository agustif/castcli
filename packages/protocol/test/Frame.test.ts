// Conformance tests for the Cast wire format.
//
// The wire keys are generated from `docs/reference/cast_channel.proto`, so the
// job here is to prove the generated descriptors actually match the checked-in
// protobuf, and that the codec round-trips both payload representations.
//
// This is the test that would have caught a transcription error in the original
// hand-written encoder — which used literal `0x12`/`0x1a` constants that were
// correct, but correct only because someone read them off carefully once.

import { assert, describe, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { CastMessageFields, PayloadType, ProtocolVersion } from "../src/Generated.ts"
import { decodeMessage, encodeFrame, Payload, takeFrames } from "../src/Frame.ts"

const PROTO = path.resolve(import.meta.dirname, "../proto/cast_channel.proto")

/** Read the field numbers straight out of the proto, independently of codegen. */
const fieldsFromProto = (): ReadonlyMap<string, { number: number; type: string }> => {
  const source = readFileSync(PROTO, "utf8")
  const body = source.slice(source.indexOf("message CastMessage"))
  const end = body.indexOf("\n}")
  return new Map(
    body
      .slice(0, end)
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(required|optional)\s+([A-Za-z0-9_.]+)\s+([a-z0-9_]+)\s*=\s*(\d+)/
          .exec(line)
        const name = match?.[3]
        const number = match?.[4]
        const type = match?.[2]
        return name === undefined || number === undefined || type === undefined
          ? []
          : [[name, { number: Number(number), type }] as const]
      })
  )
}

describe("Generated descriptors", () => {
  it("covers every CastMessage field declared in the proto", () => {
    const declared = fieldsFromProto()
    assert.strictEqual(declared.size, 7, "the proto should declare seven fields")
    declared.forEach((_, name) => {
      assert.isTrue(name in CastMessageFields, `${name} is missing from the generated table`)
    })
  })

  it("assigns each field the number the proto gives it", () => {
    fieldsFromProto().forEach((declared, name) => {
      const generated = Object.entries(CastMessageFields).find(([key]) => key === name)?.[1]
      assert.strictEqual(generated?.number, declared.number, `${name} field number`)
    })
  })

  it("derives wire keys as (number << 3) | wireType", () => {
    Object.entries(CastMessageFields).forEach(([name, descriptor]) => {
      const expected = (descriptor.number << 3) | (descriptor.wire === "length" ? 2 : 0)
      assert.strictEqual(descriptor.key, expected, `${name} wire key`)
    })
  })

  it("keeps the enum values the proto defines", () => {
    assert.strictEqual(ProtocolVersion.CASTV2_1_0, 0)
    assert.strictEqual(PayloadType.STRING, 0)
    assert.strictEqual(PayloadType.BINARY, 1)
  })
})

describe("Frame codec", () => {
  const message = {
    sourceId: "sender-0",
    destinationId: "receiver-0",
    namespace: "urn:x-cast:com.google.cast.receiver",
    payload: Payload.Text({ value: `{"type":"GET_STATUS","requestId":1}` })
  }

  it("prefixes each frame with its big-endian length", () => {
    const frame = encodeFrame(message)
    assert.strictEqual(frame.readUInt32BE(0), frame.length - 4)
  })

  it("round-trips a text payload", () => {
    const decoded = decodeMessage(encodeFrame(message).subarray(4))
    assert.deepStrictEqual(decoded, message)
  })

  it("round-trips a binary payload, as the device-auth namespace uses", () => {
    const binary = {
      sourceId: "sender-0",
      destinationId: "receiver-0",
      namespace: "urn:x-cast:com.google.cast.tp.deviceauth",
      payload: Payload.Binary({ value: new Uint8Array([0, 1, 2, 250, 255]) })
    }
    const decoded = decodeMessage(encodeFrame(binary).subarray(4))
    assert.deepStrictEqual(decoded, binary)
  })

  it("survives UTF-8 outside the ASCII range", () => {
    const accented = { ...message, payload: Payload.Text({ value: `{"t":"REVELACIÓN ñ 日本"}` }) }
    const decoded = decodeMessage(encodeFrame(accented).subarray(4))
    assert.deepStrictEqual(decoded, accented)
  })

  it("reassembles frames split across reads, and keeps the remainder", () => {
    // Cast frames do not align with TCP reads; the partial tail must survive.
    const whole = Buffer.concat([encodeFrame(message), encodeFrame(message)])
    const split = whole.length - 5
    const [first, rest] = takeFrames(whole.subarray(0, split))
    assert.strictEqual(first.length, 1, "only the complete frame is emitted")
    const [second, leftover] = takeFrames(Buffer.concat([rest, whole.subarray(split)]))
    assert.strictEqual(second.length, 1)
    assert.strictEqual(leftover.length, 0, "nothing left over once both are complete")
  })

  it("emits nothing when the length prefix is not yet complete", () => {
    const [frames, rest] = takeFrames(Buffer.from([0, 0]))
    assert.strictEqual(frames.length, 0)
    assert.strictEqual(rest.length, 2)
  })
})
