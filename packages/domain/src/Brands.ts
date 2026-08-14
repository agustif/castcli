// Branded scalars.
//
// Almost every value in this codebase is a number, and most of the bugs worth
// preventing are two numbers swapped. A seek offset, a bitrate, a stream index
// and a port are all `number` to TypeScript; branding them makes passing one
// where another is expected a compile error rather than a silent mis-seek.
//
// These are Schema brands rather than plain type aliases, so the same
// declaration validates at the edges (CLI flags, ffprobe output, config) and
// constrains the types inside.

import { Schema } from "effect"

/** A position or duration in seconds. Never negative. */
export const Seconds = Schema.Number.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(0, { message: "expected a position at or after the start" })
  ),
  Schema.brand("Seconds")
)
export type Seconds = typeof Seconds.Type

/** Bits per second. Distinct from Seconds so the two cannot be confused. */
export const Bitrate = Schema.Number.pipe(
  Schema.check(Schema.isGreaterThan(0, { message: "expected a bitrate in bits per second" })),
  Schema.brand("Bitrate")
)
export type Bitrate = typeof Bitrate.Type

/** A vertical resolution, e.g. 720. */
export const Height = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0, { message: "expected a height in pixels, such as 720" })),
  Schema.brand("Height")
)
export type Height = typeof Height.Type

/** An index into a container's stream table, as ffmpeg's `-map 0:N` uses. */
export const StreamIndex = Schema.Int.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(0, {
      message: "expected a stream index as listed by `cast streams`"
    })
  ),
  Schema.brand("StreamIndex")
)
export type StreamIndex = typeof StreamIndex.Type

/**
 * A dotted-quad IPv4 address.
 *
 * Branded specifically because the bug this tool exists to fix was an IPv6
 * link-local address reaching a field that had to be IPv4: making the type
 * refuse anything else moves that failure to compile time.
 */
const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)"

export const Ipv4 = Schema.String.pipe(
  // The octet ranges are part of the pattern, not merely its shape. The
  // previous `\d{1,3}` version accepted 999.999.999.999 and 256.0.0.1 — which
  // defeats the point of a brand whose whole job is rejecting addresses a
  // device cannot be reached at. Leading zeros are rejected too: they read as
  // octal to some resolvers.
  // The annotation matters as much as the pattern: without it a mistyped --ip
  // shows the raw regular expression, which tells a person nothing about what
  // to type instead.
  Schema.check(
    Schema.isPattern(new RegExp(`^(${OCTET}\\.){3}${OCTET}$`), {
      message: "expected an IPv4 address such as 192.168.1.24"
    })
  ),
  Schema.brand("Ipv4")
)
export type Ipv4 = typeof Ipv4.Type

/** A TCP port. */
export const Port = Schema.Int.pipe(
  Schema.check(
    Schema.isBetween({ minimum: 1, maximum: 65_535 }, {
      message: "expected a port between 1 and 65535"
    })
  ),
  Schema.brand("Port")
)
export type Port = typeof Port.Type

/**
 * Identifiers the receiver hands us. They are opaque strings, but they are not
 * interchangeable: sending a media command to a session id, or connecting to a
 * media session id, both produce silence rather than an error.
 */
export const SessionId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("SessionId")
)
export type SessionId = typeof SessionId.Type

/** The destination a media command must be addressed to. */
export const TransportId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.brand("TransportId")
)
export type TransportId = typeof TransportId.Type

/** Identifies the loaded media, and must accompany every media command. */
export const MediaSessionId = Schema.Int.pipe(Schema.brand("MediaSessionId"))
export type MediaSessionId = typeof MediaSessionId.Type

/**
 * An audio bitrate in ffmpeg's spelling: a number with a unit suffix. Kept as a
 * pattern rather than a number because it is passed through to ffmpeg verbatim.
 */
export const AudioBitrate = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d+k$/, { message: "expected an audio bitrate such as 128k" })
  ),
  Schema.brand("AudioBitrate")
)
export type AudioBitrate = typeof AudioBitrate.Type

/**
 * Receiver volume, 0 to 1. Branded because the previous signature took any
 * number and silently clamped it, so `setVolume(20)` — a plausible way to mean
 * twenty percent — quietly became full volume.
 */
export const VolumeLevel = Schema.Number.pipe(
  Schema.check(
    Schema.isBetween({ minimum: 0, maximum: 1 }, {
      message: "expected a volume between 0 and 1 — the CLI takes a percentage and converts"
    })
  ),
  Schema.brand("VolumeLevel")
)
export type VolumeLevel = typeof VolumeLevel.Type

/**
 * An absolute path to a media file. Branded so it cannot be confused with the
 * many other strings passed to ffmpeg — a codec name, a muxer, a URL.
 */
export const FilePath = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1, { message: "expected a path to a media file" })),
  Schema.brand("FilePath")
)
export type FilePath = typeof FilePath.Type

/** Identifier for a text track offered to the receiver. */
export const TrackId = Schema.Int.pipe(Schema.brand("TrackId"))
export type TrackId = typeof TrackId.Type

// --- constructing branded values ------------------------------------------
//
// Every schema carries its own constructors, so there is no hand-rolled helper
// here and nothing is asserted into place:
//
//   Bitrate.makeEffect(1_800_000)   validates, failure stays in the error channel
//   Bitrate.makeOption(value)       validates, absent on failure
//   Bitrate.make(1_800_000)         validates, throws — for values this repo
//                                   controls, where a failure is a programming
//                                   error rather than bad input
//
// The previous version of this file exported `(value: number) => value as Bitrate`
// helpers. Those were casts: they carried the brand's *type* with none of its
// guarantee, so `Port.make(70000)` produced a "validated" port that had never
// been checked.
