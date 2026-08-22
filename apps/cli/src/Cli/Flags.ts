// Shared, schema-validated flags and arguments.
//
// Two things are happening here that a bare `Flag.string("ip")` does not do:
//
//   * every flag decodes through a Schema, so `--ip notanaddress` or
//     `--seek banana` fails during argument parsing with a readable message,
//     and the handler receives a branded type rather than a loose string;
//   * flags fall back to `Config`, so the same knob can come from a flag or an
//     environment variable without the handler knowing which.
//
// Defining them once here also means `play` and any future subcommand share the
// same parsing rules instead of restating them.

import { Argument, Flag } from "effect/unstable/cli"
import { Ipv4, StreamIndex } from "@castcli/domain"
import { TimeCode } from "./TimeCode.ts"

/** The media file. `mustExist` turns a typo into a parse error, not a probe failure. */
export const mediaFile = Argument.file("file", { mustExist: true }).pipe(
  Argument.withDescription("Path to the media file")
)

/**
 * Skips discovery. Worth having because mDNS unicast replies get dropped often
 * enough on a congested network that discovery alone is unreliable.
 */
export const deviceIp = Flag.string("ip").pipe(
  Flag.withSchema(Ipv4),
  Flag.withDescription("Device address, skipping discovery"),
  Flag.optional
)

export const deviceName = Flag.string("device").pipe(
  Flag.withDescription("Pick a device by name substring"),
  Flag.optional
)

export const audioStream = Flag.integer("audio").pipe(
  Flag.withSchema(StreamIndex),
  Flag.withDescription("Audio stream index (see `cast streams`)"),
  Flag.optional
)

export const subtitleStream = Flag.integer("subs").pipe(
  Flag.withSchema(StreamIndex),
  Flag.withDescription("Subtitle stream index, served as a WebVTT sidecar"),
  Flag.optional
)

/**
 * Optional rather than defaulting to zero: "not given" and "start from the
 * beginning" are different requests. Without the distinction there is no way to
 * express resuming, because every invocation would look like `--seek 0`.
 */
/**
 * Serve progressive single stream instead of HLS.
 *
 * HLS is the default: the receiver picks the quality and seeks natively, so
 * neither costs a restart. Progressive is the fallback for files or receivers
 * where HLS is not possible.
 */
export const progressive = Flag.boolean("progressive").pipe(
  Flag.withDescription("Serve progressive stream: single quality, seeking restarts")
)

export const seek = Flag.string("seek").pipe(
  Flag.withSchema(TimeCode),
  Flag.withDescription("Start position: seconds, mm:ss or h:mm:ss (default: resume)"),
  Flag.optional
)
