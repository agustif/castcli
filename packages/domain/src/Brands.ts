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
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("Seconds")
)
export type Seconds = typeof Seconds.Type

/** Bits per second. Distinct from Seconds so the two cannot be confused. */
export const Bitrate = Schema.Number.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.brand("Bitrate")
)
export type Bitrate = typeof Bitrate.Type

/** A vertical resolution, e.g. 720. */
export const Height = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.brand("Height")
)
export type Height = typeof Height.Type

/** An index into a container's stream table, as ffmpeg's `-map 0:N` uses. */
export const StreamIndex = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
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
  Schema.check(Schema.isPattern(new RegExp(`^(${OCTET}\\.){3}${OCTET}$`))),
  Schema.brand("Ipv4")
)
export type Ipv4 = typeof Ipv4.Type

/** A TCP port. */
export const Port = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  Schema.brand("Port")
)
export type Port = typeof Port.Type

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
