// SubRip output.
//
// This format exists in the project for one reason: a DLNA renderer is told its
// subtitle track is `text/srt`, and a Samsung or LG set handed WebVTT at that
// URL fetches it, fails to parse it, and shows nothing. The differences are
// small and each one is enough to cause that.

import { assert, describe, it } from "@effect/vitest"
import { encode } from "../src/Vtt/Srt.ts"
import type { Cues } from "../src/Vtt/Codec.ts"

const CUES: Cues = [
  { start: 1, end: 4, settings: "", text: "first line" },
  { start: 3661.5, end: 3663.25, settings: "", text: "over an hour in" }
]

describe("SubRip", () => {
  it("numbers cues from one", () => {
    // Some players index by the counter, and a track numbered from zero or
    // with gaps confuses them.
    const lines = encode(CUES).split("\n")
    assert.strictEqual(lines[0], "1")
    assert.isTrue(encode(CUES).includes("\n2\n"))
  })

  it("separates the milliseconds with a comma, not a full stop", () => {
    // The single most common reason an SRT parser rejects a file on its first
    // timestamp: WebVTT writes `00:00:01.000` and SubRip requires the comma.
    assert.include(encode(CUES), "00:00:01,000 --> 00:00:04,000")
    assert.notInclude(encode(CUES), "00:00:01.000")
  })

  it("pads the hours, which WebVTT allows to be omitted", () => {
    assert.include(encode(CUES), "01:01:01,500 --> 01:01:03,250")
  })

  it("has no WEBVTT header", () => {
    // Its presence is what makes a set reject the file outright.
    assert.notInclude(encode(CUES), "WEBVTT")
  })

  it("writes nothing for an empty track", () => {
    assert.strictEqual(encode([]), "")
  })
})
