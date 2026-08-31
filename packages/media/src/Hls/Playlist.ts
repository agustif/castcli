// HLS playlists, as values.
//
// Why HLS at all: previously we served one stream at one bitrate, so the
// receiver could not choose and we had to *infer* spare bandwidth from indirect
// evidence — an elaborate estimator for a quantity the receiver already knows,
// its own buffer level. Changing bitrate meant restarting ffmpeg and reissuing
// LOAD, which the viewer saw as a rebuffer, and seeking meant the same thing
// because a live pipe has no byte ranges to seek within.
//
// A VOD playlist fixes both by construction. Every segment of every variant is
// addressable, so the receiver switches quality on a segment boundary and seeks
// by asking for a different segment. Nothing restarts.
//
// The segments do not exist until they are asked for. The playlist is arithmetic
// — duration divided by segment length — so declaring 1,500 segments across six
// variants costs nothing, and only the ones actually fetched are ever encoded.

import { Array, Duration } from "effect"
import type { Rung } from "@castcli/domain"
import { Height, Seconds } from "@castcli/domain"

/**
 * Six seconds, which is Apple's recommended target and what the Cast receiver
 * is tuned for. It trades startup latency against request overhead: shorter
 * segments mean more ffmpeg invocations, each paying process startup.
 */
export const SEGMENT_DURATION = Duration.seconds(6)

const segmentSeconds = Duration.toSeconds(SEGMENT_DURATION)

/**
 * How many segments a film of this length needs.
 *
 * Rounded up, because the final partial segment still holds picture — flooring
 * it silently truncates the end of every film, which is the kind of thing
 * nobody notices until the credits are missing.
 */
export const segmentCount = (duration: Seconds): number =>
  Math.max(1, Math.ceil(duration / segmentSeconds))

/** Where a segment starts in the film. */
export const segmentStart = (index: number): Seconds =>
  Seconds.make(index * segmentSeconds)

/**
 * How long a segment runs. Every one is a full segment except the last, which
 * is whatever is left — and `EXTINF` has to state that honestly or the receiver
 * miscalculates the seek bar.
 */
export const segmentLength = (index: number, duration: Seconds): number =>
  Math.min(segmentSeconds, Math.max(0, duration - index * segmentSeconds))

/** 16:9 is assumed for the advertised resolution; only the height is ours. */
const widthFor = (height: Height): number => Math.round((height * 16) / 9 / 2) * 2

/**
 * Which rungs can be offered as HLS variants: the encoded ones only.
 *
 * A stream-copy rung cannot be cut into segments at arbitrary times. Input
 * seeking lands on the nearest keyframe, so with a GOP that does not divide the
 * segment length the pieces overlap and drift from what the playlist declares —
 * measured at 5s/10s/15s for segments announced as 6s/12s/18s, durations
 * 7.1/8.1/9.2, an error that grows with every one. Re-encoding forces a keyframe
 * at the segment start, which is the premise of switching variants mid-film.
 *
 * The result can be empty — a source below every encoded rung has nothing but a
 * copy — and the caller has to treat that as "HLS is not possible for this
 * file" rather than serving a playlist with no variants in it.
 */
export const variantsFor = (ladder: ReadonlyArray<Rung>): ReadonlyArray<Rung> =>
  ladder.filter((rung) => rung._tag === "Encode")

/**
 * The master playlist: one variant per rung.
 *
 * `BANDWIDTH` is what the receiver picks on, so it has to be the *peak* rate
 * rather than the average — understating it is how a variant gets chosen that
 * the link cannot actually carry. The audio is added for the same reason.
 */
export const master = (
  rungs: ReadonlyArray<Rung>,
  audioBitsPerSecond: number,
  variantUrl: (index: number) => string
): string =>
  [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    ...Array.flatMap(rungs, (rung, index) => [
      `#EXT-X-STREAM-INF:BANDWIDTH=${rung.bitrate + audioBitsPerSecond},` +
        `RESOLUTION=${widthFor(rung.height)}x${rung.height},CODECS="avc1.64001e,mp4a.40.2"`,
      variantUrl(index)
    ]),
    ""
  ].join("\n")

/**
 * A media playlist for one variant: every segment of the film, listed up front.
 *
 * `EXT-X-PLAYLIST-TYPE:VOD` plus `EXT-X-ENDLIST` is what tells the receiver
 * this is a complete, seekable programme rather than a live edge it should
 * follow. Without them it will not offer a seek bar.
 */
export const media = (
  duration: Seconds,
  segmentUrl: (segment: number) => string
): string => {
  const count = segmentCount(duration)
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    // Must be an integer and must not be less than any EXTINF, or players
    // reject the playlist outright.
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentSeconds)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    ...Array.flatMap(Array.range(0, count - 1), (index) => [
      `#EXTINF:${segmentLength(index, duration).toFixed(3)},`,
      segmentUrl(index)
    ]),
    "#EXT-X-ENDLIST",
    ""
  ].join("\n")
}

/** `application/vnd.apple.mpegurl` is the registered type; both are accepted. */
export const CONTENT_TYPE = "application/x-mpegurl"

/** MPEG-TS with AAC audio, which is what the segment encoder produces. */
export const SEGMENT_CONTENT_TYPE = "video/mp2t"
