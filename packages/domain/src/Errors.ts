// Every failure mode this tool has, as typed tagged errors.
//
// Nothing here is a thrown `Error`: each case appears in the effect's type, so
// callers handle what they can recover from and the compiler tracks the rest.
// `Schema.Defect()` preserves the underlying cause instead of flattening it to a
// string, which is what makes a failure diagnosable after the fact.

import { Schema } from "effect"

export class DiscoveryError extends Schema.TaggedError<DiscoveryError>()(
  "DiscoveryError",
  { message: Schema.String }
) {}

export class DeviceNotFoundError extends Schema.TaggedError<DeviceNotFoundError>()(
  "DeviceNotFoundError",
  { query: Schema.String, found: Schema.Array(Schema.String) }
) {
  override get message(): string {
    return this.found.length === 0
      ? `no Cast devices answered; wanted "${this.query}"`
      : `no device matching "${this.query}" — found: ${this.found.join(", ")}`
  }
}

export class CastProtocolError extends Schema.TaggedError<CastProtocolError>()(
  "CastProtocolError",
  { message: Schema.String }
) {}

/** The receiver accepted the connection but refused to play the media. */
export class LoadFailedError extends Schema.TaggedError<LoadFailedError>()(
  "LoadFailedError",
  { detail: Schema.String }
) {}

export class MediaProbeError extends Schema.TaggedError<MediaProbeError>()(
  "MediaProbeError",
  { path: Schema.String, cause: Schema.Defect() }
) {
  override get message(): string {
    return `could not read ${this.path}: ${String(this.cause)}`
  }
}

export class TranscodeError extends Schema.TaggedError<TranscodeError>()(
  "TranscodeError",
  { cause: Schema.Defect() }
) {}

/**
 * No usable LAN address. Worth its own case because the advertised address is
 * the single thing this tool exists to get right.
 */
export class NoLocalAddressError extends Schema.TaggedError<NoLocalAddressError>()(
  "NoLocalAddressError",
  {}
) {
  override get message(): string {
    return "no non-loopback IPv4 address found — is this machine on a network?"
  }
}

/** The file has no video track, so there is nothing to cast. */
export class NoVideoStreamError extends Schema.TaggedError<NoVideoStreamError>()(
  "NoVideoStreamError",
  { path: Schema.String }
) {
  override get message(): string {
    return `${this.path} has no video stream`
  }
}

/**
 * The control socket closed. On a weak link the device resets it with no
 * warning, so this is an ordinary, recoverable condition rather than a fault:
 * the session is rebuilt and playback resumes from the last known position.
 */
export class ConnectionLostError extends Schema.TaggedError<ConnectionLostError>()(
  "ConnectionLostError",
  {}
) {
  override get message(): string {
    return "the Cast control connection closed"
  }
}

/**
 * A quality ladder with no rungs. Reachable only if the source resolution is
 * below every rung, which the builder is written to prevent — but the type
 * cannot say so, and asserting it would be exactly the escape hatch this
 * codebase bans.
 */
export class EmptyLadderError extends Schema.TaggedError<EmptyLadderError>()(
  "EmptyLadderError",
  {}
) {
  override get message(): string {
    return "no quality rung fits this source"
  }
}
