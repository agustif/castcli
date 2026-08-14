// HLS playlists.
//
// Playlists are unforgiving in specific ways — a TARGETDURATION below any
// EXTINF, or a missing ENDLIST, and the receiver declines the whole
// presentation rather than complaining about the line. These pin the rules that
// are easy to get subtly wrong and impossible to notice by eye.

import { assert, describe, it } from "@effect/vitest"
import { Bitrate, Height, Rung, Seconds } from "@castcli/domain"
import { master, media, segmentCount, segmentLength, segmentStart } from "../src/Hls/Playlist.ts"

const rung = (height: number, bitrate: number) =>
  Rung.Encode({ height: Height.make(height), bitrate: Bitrate.make(bitrate) })

const LADDER = [rung(360, 800_000), rung(720, 2_500_000)]

const lines = (playlist: string) =>
  playlist.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)

describe("segment arithmetic", () => {
  it("rounds the count up, so the end of the film is not lost", () => {
    // 30s is five whole segments; 31s needs a sixth holding one second. Flooring
    // silently truncates every film that is not an exact multiple.
    assert.strictEqual(segmentCount(Seconds.make(30)), 5)
    assert.strictEqual(segmentCount(Seconds.make(31)), 6)
  })

  it("never claims zero segments", () => {
    // A playlist with no segments is accepted and then plays nothing.
    assert.strictEqual(segmentCount(Seconds.make(0.5)), 1)
  })

  it("places each segment where ffmpeg will be told to seek", () => {
    assert.strictEqual(segmentStart(0), 0)
    assert.strictEqual(segmentStart(3), 18)
  })

  it("shortens only the last segment", () => {
    assert.strictEqual(segmentLength(0, Seconds.make(31)), 6)
    assert.strictEqual(segmentLength(4, Seconds.make(31)), 6)
    assert.strictEqual(segmentLength(5, Seconds.make(31)), 1)
  })
})

describe("master playlist", () => {
  it("advertises one variant per rung, in ladder order", () => {
    const playlist = lines(master(LADDER, 128_000, (index) => `/v${index}.m3u8`))

    assert.deepStrictEqual(
      playlist.filter((line) => line.endsWith(".m3u8")),
      ["/v0.m3u8", "/v1.m3u8"]
    )
  })

  it("states bandwidth including the audio, which the receiver compares against", () => {
    // Understating BANDWIDTH is how a variant gets chosen that the link cannot
    // actually carry, so the audio has to be in the number.
    const playlist = master(LADDER, 128_000, (index) => `/v${index}.m3u8`)

    assert.include(playlist, "BANDWIDTH=928000")
    assert.include(playlist, "BANDWIDTH=2628000")
  })

  it("gives each variant a resolution", () => {
    const playlist = master(LADDER, 128_000, (index) => `/v${index}.m3u8`)

    assert.include(playlist, "RESOLUTION=640x360")
    assert.include(playlist, "RESOLUTION=1280x720")
  })

  it("starts with the tag that makes it a playlist at all", () => {
    assert.strictEqual(lines(master(LADDER, 128_000, (i) => `/v${i}.m3u8`))[0], "#EXTM3U")
  })
})

describe("media playlist", () => {
  const playlist = media(Seconds.make(31), (segment) => `/v0/${segment}.ts`)

  it("lists every segment", () => {
    assert.deepStrictEqual(
      lines(playlist).filter((line) => line.endsWith(".ts")),
      ["/v0/0.ts", "/v0/1.ts", "/v0/2.ts", "/v0/3.ts", "/v0/4.ts", "/v0/5.ts"]
    )
  })

  it("declares VOD and ends the list, which is what offers a seek bar", () => {
    // Without both, the receiver treats it as a live edge to follow and will
    // not let anyone seek — which is the whole reason for serving HLS here.
    assert.include(playlist, "#EXT-X-PLAYLIST-TYPE:VOD")
    assert.include(playlist, "#EXT-X-ENDLIST")
  })

  it("keeps TARGETDURATION a whole number and no smaller than any segment", () => {
    const target = Number(
      lines(playlist).find((line) => line.startsWith("#EXT-X-TARGETDURATION:"))
        ?.split(":")[1] ?? "0"
    )
    const longest = Math.max(
      ...lines(playlist)
        .filter((line) => line.startsWith("#EXTINF:"))
        .map((line) => Number(line.slice("#EXTINF:".length).replace(",", "")))
    )

    assert.isTrue(Number.isInteger(target))
    assert.isAtLeast(target, longest)
  })

  it("states the true length of the final, short segment", () => {
    const durations = lines(playlist)
      .filter((line) => line.startsWith("#EXTINF:"))
      .map((line) => Number(line.slice("#EXTINF:".length).replace(",", "")))

    assert.deepStrictEqual(durations, [6, 6, 6, 6, 6, 1])
  })
})
