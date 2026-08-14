// What ffprobe tells us about a file.
//
// Decoded through Schema rather than trusted: ffprobe's JSON is loose (bitrates
// arrive as strings, most fields are optional, and they vary by container), so
// validating once at the boundary keeps the rest of the code working with real
// types instead of `any`.

import { Schema } from "effect"
import { Bitrate } from "./Brands.ts"

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
  get durationSeconds(): number {
    return Number(this.format.duration) || 0
  }
  get video(): MediaStream | undefined {
    return this.streams.find((stream) => stream.isVideo)
  }
  get audioStreams(): ReadonlyArray<MediaStream> {
    return this.streams.filter((stream) => stream.isAudio)
  }
  get subtitleStreams(): ReadonlyArray<MediaStream> {
    return this.streams.filter((stream) => stream.isSubtitle)
  }
}
