import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as PlaybackInfo from "../src/PlaybackInfo/index.ts"

describe("PlaybackInfo parser", () => {
  describe("valid plist", () => {
    it.effect("decodes complete playback-info", () =>
      Effect.gen(function*() {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>duration</key><real>120.5</real>
  <key>position</key><real>42.0</real>
  <key>rate</key><real>1</real>
  <key>readyToPlay</key><true />
</dict>
</plist>`

        const info = yield* PlaybackInfo.parse(xml)

        assert.strictEqual(info.duration, 120.5)
        assert.strictEqual(info.position, 42.0)
        assert.strictEqual(info.rate, 1)
        assert.strictEqual(info.readyToPlay, true)
      }))

    it.effect("decodes with false readyToPlay", () =>
      Effect.gen(function*() {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>duration</key><real>0</real>
  <key>position</key><real>0</real>
  <key>rate</key><real>0</real>
  <key>readyToPlay</key><false />
</dict>
</plist>`

        const info = yield* PlaybackInfo.parse(xml)

        assert.strictEqual(info.readyToPlay, false)
      }))

    it.effect("decodes with missing optional fields", () =>
      Effect.gen(function*() {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>rate</key><real>1</real>
</dict>
</plist>`

        const info = yield* PlaybackInfo.parse(xml)

        assert.strictEqual(info.duration, undefined)
        assert.strictEqual(info.position, undefined)
        assert.strictEqual(info.rate, 1)
        assert.strictEqual(info.readyToPlay, undefined)
      }))

    it.effect("decodes emulator format", () =>
      Effect.gen(function*() {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>duration</key><real>0</real>
  <key>position</key><real>0</real>
  <key>rate</key><real>1</real>
  <key>readyToPlay</key><true />
</dict>
</plist>`

        const info = yield* PlaybackInfo.parse(xml)

        assert.strictEqual(info.duration, 0)
        assert.strictEqual(info.position, 0)
        assert.strictEqual(info.rate, 1)
        assert.strictEqual(info.readyToPlay, true)
      }))

    it.effect("decodes with decimal positions", () =>
      Effect.gen(function*() {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>duration</key><real>3600.125</real>
  <key>position</key><real>1234.567</real>
  <key>rate</key><real>1.5</real>
  <key>readyToPlay</key><true />
</dict>
</plist>`

        const info = yield* PlaybackInfo.parse(xml)

        assert.strictEqual(info.duration, 3600.125)
        assert.strictEqual(info.position, 1234.567)
        assert.strictEqual(info.rate, 1.5)
      }))
  })

  describe("malformed input", () => {
    it.effect("fails on invalid XML", () =>
      Effect.gen(function*() {
        const xml = `<not-closed>`

        const error = yield* Effect.flip(PlaybackInfo.parse(xml))

        assert.instanceOf(error, PlaybackInfo.MalformedPlaybackInfo)
        assert.include(error.message, "not valid XML")
      }))

    it.effect("fails on non-plist XML", () =>
      Effect.gen(function*() {
        const xml = `<?xml version="1.0"?><root><item>value</item></root>`

        const error = yield* Effect.flip(PlaybackInfo.parse(xml))

        assert.instanceOf(error, PlaybackInfo.MalformedPlaybackInfo)
        assert.include(error.message, "not a plist dict")
      }))

    it.effect("fails on empty string", () =>
      Effect.gen(function*() {
        const xml = ``

        const error = yield* Effect.flip(PlaybackInfo.parse(xml))

        assert.instanceOf(error, PlaybackInfo.MalformedPlaybackInfo)
      }))

    it.effect("fails on malformed plist structure", () =>
      Effect.gen(function*() {
        const xml = `<?xml version="1.0"?>
<plist version="1.0">
<array>
  <string>not a dict</string>
</array>
</plist>`

        const error = yield* Effect.flip(PlaybackInfo.parse(xml))

        assert.instanceOf(error, PlaybackInfo.MalformedPlaybackInfo)
      }))
  })

  describe("edge cases", () => {
    it.effect("handles whitespace in values", () =>
      Effect.gen(function*() {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>duration</key>
  <real>
    120.5
  </real>
  <key>position</key>
  <real>  42.0  </real>
</dict>
</plist>`

        const info = yield* PlaybackInfo.parse(xml)

        assert.strictEqual(info.duration, 120.5)
        assert.strictEqual(info.position, 42.0)
      }))

    it.effect("decodes with only boolean field", () =>
      Effect.gen(function*() {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>readyToPlay</key><true />
</dict>
</plist>`

        const info = yield* PlaybackInfo.parse(xml)

        assert.strictEqual(info.duration, undefined)
        assert.strictEqual(info.position, undefined)
        assert.strictEqual(info.rate, undefined)
        assert.strictEqual(info.readyToPlay, true)
      }))

    it.effect("decodes zero values correctly", () =>
      Effect.gen(function*() {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>duration</key><real>0</real>
  <key>position</key><real>0</real>
  <key>rate</key><real>0</real>
  <key>readyToPlay</key><false />
</dict>
</plist>`

        const info = yield* PlaybackInfo.parse(xml)

        assert.strictEqual(info.duration, 0)
        assert.strictEqual(info.position, 0)
        assert.strictEqual(info.rate, 0)
        assert.strictEqual(info.readyToPlay, false)
      }))
  })

  describe("binary plist", () => {
    it.effect("decodes complete binary playback-info", () =>
      Effect.gen(function*() {
        const binary = new Uint8Array([
          98, 112, 108, 105, 115, 116, 48, 48, 212, 1, 2, 3, 4, 5, 6, 7, 8, 88,
          100, 117, 114, 97, 116, 105, 111, 110, 88, 112, 111, 115, 105, 116,
          105, 111, 110, 84, 114, 97, 116, 101, 91, 114, 101, 97, 100, 121, 84,
          111, 80, 108, 97, 121, 35, 64, 94, 32, 0, 0, 0, 0, 0, 16, 42, 16, 1, 9,
          8, 17, 26, 35, 40, 52, 61, 63, 65, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0,
          0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 66
        ])

        const info = yield* PlaybackInfo.parse(binary)

        assert.strictEqual(info.duration, 120.5)
        assert.strictEqual(info.position, 42.0)
        assert.strictEqual(info.rate, 1)
        assert.strictEqual(info.readyToPlay, true)
      }))

    it.effect("decodes binary with false readyToPlay", () =>
      Effect.gen(function*() {
        const binary = new Uint8Array([
          98, 112, 108, 105, 115, 116, 48, 48, 212, 1, 2, 3, 4, 5, 5, 5, 6, 88,
          100, 117, 114, 97, 116, 105, 111, 110, 88, 112, 111, 115, 105, 116,
          105, 111, 110, 84, 114, 97, 116, 101, 91, 114, 101, 97, 100, 121, 84,
          111, 80, 108, 97, 121, 16, 0, 8, 8, 17, 26, 35, 40, 52, 54, 0, 0, 0, 0,
          0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 55
        ])

        const info = yield* PlaybackInfo.parse(binary)

        assert.strictEqual(info.duration, 0)
        assert.strictEqual(info.position, 0)
        assert.strictEqual(info.rate, 0)
        assert.strictEqual(info.readyToPlay, false)
      }))

    it.effect("decodes binary with missing optional fields", () =>
      Effect.gen(function*() {
        const binary = new Uint8Array([
          98, 112, 108, 105, 115, 116, 48, 48, 209, 1, 2, 84, 114, 97, 116, 101,
          16, 1, 8, 11, 16, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 18
        ])

        const info = yield* PlaybackInfo.parse(binary)

        assert.strictEqual(info.duration, undefined)
        assert.strictEqual(info.position, undefined)
        assert.strictEqual(info.rate, 1)
        assert.strictEqual(info.readyToPlay, undefined)
      }))

    it.effect("decodes binary with decimal positions", () =>
      Effect.gen(function*() {
        const binary = new Uint8Array([
          98, 112, 108, 105, 115, 116, 48, 48, 212, 1, 2, 3, 4, 5, 6, 7, 8, 88,
          100, 117, 114, 97, 116, 105, 111, 110, 88, 112, 111, 115, 105, 116,
          105, 111, 110, 84, 114, 97, 116, 101, 91, 114, 101, 97, 100, 121, 84,
          111, 80, 108, 97, 121, 35, 64, 172, 32, 64, 0, 0, 0, 0, 35, 64, 147, 74,
          68, 155, 165, 227, 84, 35, 63, 248, 0, 0, 0, 0, 0, 0, 9, 8, 17, 26, 35,
          40, 52, 61, 70, 79, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 9, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80
        ])

        const info = yield* PlaybackInfo.parse(binary)

        assert.strictEqual(info.duration, 3600.125)
        assert.strictEqual(info.position, 1234.567)
        assert.strictEqual(info.rate, 1.5)
        assert.strictEqual(info.readyToPlay, true)
      }))

    it.effect("fails on invalid binary plist", () =>
      Effect.gen(function*() {
        const binary = new Uint8Array([98, 112, 108, 105, 115, 116, 48, 48, 0, 0, 0])

        const error = yield* Effect.flip(PlaybackInfo.parse(binary))

        assert.instanceOf(error, PlaybackInfo.MalformedPlaybackInfo)
        assert.include(error.message, "not a valid binary plist")
      }))

    it.effect("decodes binary plist string encoding", () =>
      Effect.gen(function*() {
        const binaryStr = "bplist00\xd4\x01\x02\x03\x04\x05\x06\x07\x08Xduration..."

        const error = yield* Effect.flip(PlaybackInfo.parse(binaryStr))

        assert.instanceOf(error, PlaybackInfo.MalformedPlaybackInfo)
      }))
  })
})
