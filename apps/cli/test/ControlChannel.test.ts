import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Seconds } from "@castcli/domain"
import * as ControlChannel from "../src/ControlChannel.ts"

describe("ControlChannel request/response schemas", () => {
  it.effect("encodes and decodes a Seek request", () =>
    Effect.gen(function*() {
      const request = { _tag: "Seek" as const, toSeconds: Seconds.make(42) }
      const encoded = yield* ControlChannel.encodeRequest(request)
      const decoded = yield* ControlChannel.decodeRequest(encoded)

      assert.strictEqual(decoded._tag, "Seek")
      assert.strictEqual(decoded._tag === "Seek" && Number(decoded.toSeconds), 42)
    }))

  it.effect("encodes and decodes a Pause request", () =>
    Effect.gen(function*() {
      const request = { _tag: "Pause" as const }
      const encoded = yield* ControlChannel.encodeRequest(request)
      const decoded = yield* ControlChannel.decodeRequest(encoded)

      assert.strictEqual(decoded._tag, "Pause")
    }))

  it.effect("encodes and decodes a Resume request", () =>
    Effect.gen(function*() {
      const request = { _tag: "Resume" as const }
      const encoded = yield* ControlChannel.encodeRequest(request)
      const decoded = yield* ControlChannel.decodeRequest(encoded)

      assert.strictEqual(decoded._tag, "Resume")
    }))

  it.effect("encodes and decodes a GetStatus request", () =>
    Effect.gen(function*() {
      const request = { _tag: "GetStatus" as const }
      const encoded = yield* ControlChannel.encodeRequest(request)
      const decoded = yield* ControlChannel.decodeRequest(encoded)

      assert.strictEqual(decoded._tag, "GetStatus")
    }))

  it.effect("encodes and decodes an Ok response", () =>
    Effect.gen(function*() {
      const response = { _tag: "Ok" as const }
      const encoded = yield* ControlChannel.encodeResponse(response)
      const decoded = yield* ControlChannel.decodeResponse(encoded)

      assert.strictEqual(decoded._tag, "Ok")
    }))

  it.effect("encodes and decodes a Status response", () =>
    Effect.gen(function*() {
      const response = {
        _tag: "Status" as const,
        file: "/path/to/file.mkv",
        offsetSeconds: Seconds.make(10),
        seekable: true
      }
      const encoded = yield* ControlChannel.encodeResponse(response)
      const decoded = yield* ControlChannel.decodeResponse(encoded)

      assert.strictEqual(decoded._tag, "Status")
      assert.strictEqual(decoded._tag === "Status" && decoded.file, "/path/to/file.mkv")
      assert.strictEqual(decoded._tag === "Status" && Number(decoded.offsetSeconds), 10)
      assert.strictEqual(decoded._tag === "Status" && decoded.seekable, true)
    }))

  it.effect("encodes and decodes an Error response", () =>
    Effect.gen(function*() {
      const response = {
        _tag: "Error" as const,
        message: "something went wrong"
      }
      const encoded = yield* ControlChannel.encodeResponse(response)
      const decoded = yield* ControlChannel.decodeResponse(encoded)

      assert.strictEqual(decoded._tag, "Error")
      assert.strictEqual(decoded._tag === "Error" && decoded.message, "something went wrong")
    }))
})
