// What ffprobe tells us about a file.
//
// Decoded through Schema rather than trusted: ffprobe's JSON is loose (bitrates
// arrive as strings, most fields are optional, and they vary by container), so
// validating once at the boundary keeps the rest of the code working with real
// types instead of `any`.

import { Option, Schema } from "effect"
import { Bitrate } from "./Brands.ts"

/**
 * ffprobe reports dispositions as 0/1 integers. Only the two that bear on
 * choosing a track are modelled; the rest are noise for this tool.
 *
 * Worth knowing before trusting them: in the release this tool was built for,
 * the 24-cue forced-signage track is flagged `default` and *not* flagged
 * `forced`, while the 1670-line dialogue track carries neither flag. These are
 * a hint, not an answer — see `Tracks/Select.ts`.
 */
const Disposition = Schema.Struct({
  default: Schema.optional(Schema.Number),
  forced: Schema.optional(Schema.Number)
})

export class MediaStream extends Schema.Class<MediaStream>("MediaStream")({
  index: Schema.Number,
  codec_type: Schema.String,
  codec_name: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  channels: Schema.optional(Schema.Number),
  pix_fmt: Schema.optional(Schema.String),
  /** ffprobe writes this as a numeric string, or omits it entirely. */
  bit_rate: Schema.optional(Schema.FiniteFromString.pipe(Schema.decodeTo(Bitrate))),
  disposition: Schema.optional(Disposition),
  tags: Schema.optional(
    Schema.Struct({
      language: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String)
    })
  )
}) {
  /**
   * Matroska omits the language element for English tracks rather than writing
   * `eng`, so an absent tag is meaningful — it is why the English audio track
   * in a Spanish release shows up untagged.
   */
  get language(): string {
    return this.tags?.language ?? "und"
  }

  /** The title a container may carry, e.g. "Forced" or "SDH". */
  get title(): Option.Option<string> {
    return Option.fromNullishOr(this.tags?.title)
  }

  get isDefault(): boolean {
    return this.disposition?.default === 1
  }
  get isForced(): boolean {
    return this.disposition?.forced === 1
  }

  get isVideo(): boolean {
    return this.codec_type === "video"
  }
  get isAudio(): boolean {
    return this.codec_type === "audio"
  }
  get isSubtitle(): boolean {
    return this.codec_type === "subtitle"
  }
}

class MediaFormat extends Schema.Class<MediaFormat>("MediaFormat")({
  duration: Schema.optional(Schema.String),
  bit_rate: Schema.optional(Schema.String)
}) {}

export class MediaInfo extends Schema.Class<MediaInfo>("MediaInfo")({
  streams: Schema.Array(MediaStream),
  format: MediaFormat
}) {
  /** Absent for containers that do not report one, rather than a zero. */
  get video(): Option.Option<MediaStream> {
    return Option.fromNullishOr(this.streams.find((stream) => stream.isVideo))
  }
  get audioStreams(): ReadonlyArray<MediaStream> {
    return this.streams.filter((stream) => stream.isAudio)
  }
  get subtitleStreams(): ReadonlyArray<MediaStream> {
    return this.streams.filter((stream) => stream.isSubtitle)
  }
}
