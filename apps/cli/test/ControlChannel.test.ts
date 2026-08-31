import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Seconds } from "@castcli/domain"

const ControlRequest = Schema.TaggedUnion({
  Seek: { toSeconds: Seconds },
  Pause: {},
  Resume: {},
  Stop: {},
  GetStatus: {}
})

const ControlResponse = Schema.TaggedUnion({
  Ok: {},
  Status: {
    file: Schema.String,
    offsetSeconds: Seconds,
    seekable: Schema.Boolean
  },
  Error: { message: Schema.String }
})

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(ControlRequest))
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(ControlRequest))
const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(ControlResponse))
const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(ControlResponse))

describe("ControlChannel request/response schemas", () => {
  it.effect("encodes and decodes a Seek request", () =>
    Effect.gen(function*() {
      const request = { _tag: "Seek" as const, toSeconds: Seconds.make(42) }
      const encoded = yield* encodeRequest(request)
      const decoded = yield* decodeRequest(encoded)

      assert.strictEqual(decoded._tag, "Seek")
      if (decoded._tag === "Seek") {
        assert.strictEqual(decoded.toSeconds, 42)
      }
    }))

  it.effect("encodes and decodes a Pause request", () =>
    Effect.gen(function*() {
      const request = { _tag: "Pause" as const }
      const encoded = yield* encodeRequest(request)
      const decoded = yield* decodeRequest(encoded)

      assert.strictEqual(decoded._tag, "Pause")
    }))

  it.effect("encodes and decodes a Resume request", () =>
    Effect.gen(function*() {
      const request = { _tag: "Resume" as const }
      const encoded = yield* encodeRequest(request)
      const decoded = yield* decodeRequest(encoded)

      assert.strictEqual(decoded._tag, "Resume")
    }))

  it.effect("encodes and decodes a GetStatus request", () =>
    Effect.gen(function*() {
      const request = { _tag: "GetStatus" as const }
      const encoded = yield* encodeRequest(request)
      const decoded = yield* decodeRequest(encoded)

      assert.strictEqual(decoded._tag, "GetStatus")
    }))

  it.effect("encodes and decodes an Ok response", () =>
    Effect.gen(function*() {
      const response = { _tag: "Ok" as const }
      const encoded = yield* encodeResponse(response)
      const decoded = yield* decodeResponse(encoded)

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
      const encoded = yield* encodeResponse(response)
      const decoded = yield* decodeResponse(encoded)

      assert.strictEqual(decoded._tag, "Status")
      if (decoded._tag === "Status") {
        assert.strictEqual(decoded.file, "/path/to/file.mkv")
        assert.strictEqual(decoded.offsetSeconds, 10)
        assert.strictEqual(decoded.seekable, true)
      }
    }))

  it.effect("encodes and decodes an Error response", () =>
    Effect.gen(function*() {
      const response = {
        _tag: "Error" as const,
        message: "something went wrong"
      }
      const encoded = yield* encodeResponse(response)
      const decoded = yield* decodeResponse(encoded)

      assert.strictEqual(decoded._tag, "Error")
      if (decoded._tag === "Error") {
        assert.strictEqual(decoded.message, "something went wrong")
      }
    }))
})
