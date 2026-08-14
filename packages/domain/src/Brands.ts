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
export const Ipv4 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(\d{1,3}\.){3}\d{1,3}$/)),
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

// --- constructors -----------------------------------------------------------
//
// Two ways in, deliberately:
//
//   * the schemas above, for values arriving from outside (ffprobe output, CLI
//     flags, mDNS records, config) — these validate;
//   * the functions below, for literals written in this repo, where the value
//     is known good and the point of the brand is to stop it being confused
//     with a different number.
//
// Anything untrusted must use the schema. These are not a way around that.

export const seconds = (value: number): Seconds => value as Seconds
export const bitrate = (value: number): Bitrate => value as Bitrate
export const height = (value: number): Height => value as Height
export const streamIndex = (value: number): StreamIndex => value as StreamIndex
export const ipv4 = (value: string): Ipv4 => value as Ipv4
export const port = (value: number): Port => value as Port
export const trackId = (value: number): TrackId => value as TrackId
