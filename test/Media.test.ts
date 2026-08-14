// The media namespace payloads.
//
// The literal sets here came out of Google's shipped receiver framework, not
// out of the prose docs, because the two disagree in places the prose does not
// flag. These tests pin the disagreements so a future "tidy-up" cannot quietly
// undo them.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as Media from "../src/Cast/Protocol/Media.ts"

describe("Media vocabulary", () => {
  it("uses lowercase HLS segment formats, as the wire does", () =>
    // The sender-side reference writes these in caps; the receiver framework
    // ships them lowercase, and the receiver is the one parsing.
    assert.isTrue(Schema.is(Media.HlsSegmentFormat)("ts_aac")))

  it("rejects the capitalised spelling the docs suggest", () =>
    assert.isFalse(Schema.is(Media.HlsSegmentFormat)("TS_AAC" as never)))

  it("accepts both the sender's OTHER and the receiver's NONE stream type", () => {
    // Sender SDK documents OTHER; receiver framework ships NONE.
    assert.isTrue(Schema.is(Media.StreamType)("OTHER"))
    assert.isTrue(Schema.is(Media.StreamType)("NONE"))
  })

  it("keeps MetadataType numeric, unlike every other enum here", () => {
    assert.strictEqual(Media.MetadataType.GENERIC, 0)
    assert.strictEqual(Media.MetadataType.MOVIE, 1)
    assert.strictEqual(Media.MetadataType.AUDIOBOOK_CHAPTER, 5)
  })

  it("knows the four player states and four idle reasons", () => {
    assert.isTrue(Schema.is(Media.PlayerState)("BUFFERING"))
    assert.isFalse(Schema.is(Media.PlayerState)("LOADING" as never))
    assert.isTrue(Schema.is(Media.IdleReason)("FINISHED"))
  })
})

describe("LoadRequest", () => {
  const track = new Media.Track({
    trackId: 1,
    type: "TEXT",
    subtype: "SUBTITLES",
    trackContentId: "http://192.168.1.82:8021/subs.vtt?o=0",
    trackContentType: "text/vtt",
    language: "spa",
    name: "Subtitles (spa)"
  })

  it("encodes to the shape a receiver expects", () =>
    Effect.gen(function*() {
      const request = new Media.LoadRequest({
        type: "LOAD",
        requestId: 3,
        sessionId: "abc",
        media: new Media.MediaInformation({
          contentId: "http://192.168.1.82:8021/stream?o=0",
          contentType: "video/mp4",
          streamType: "BUFFERED",
          tracks: [track]
        }),
        autoplay: true,
        currentTime: 0,
        activeTrackIds: [1]
      })
      const encoded = yield* Media.encodeLoad(request)
      assert.strictEqual(encoded.type, "LOAD")
      assert.strictEqual(encoded.media.streamType, "BUFFERED")
      assert.strictEqual(encoded.media.tracks?.[0]?.language, "spa")
    }).pipe(Effect.runPromise))

  it("round-trips through decode", () =>
    Effect.gen(function*() {
      const request = new Media.LoadRequest({
        type: "LOAD",
        requestId: 1,
        media: new Media.MediaInformation({
          contentId: "x",
          contentType: "video/mp4",
          streamType: "BUFFERED"
        })
      })
      const encoded = yield* Media.encodeLoad(request)
      const decoded = yield* Schema.decodeEffect(Media.LoadRequest)(encoded)
      assert.deepStrictEqual(decoded, request)
    }).pipe(Effect.runPromise))
})
