// The media namespace, typed.
//
// Every literal below is taken from an authoritative source rather than from
// community lore:
//
//   * the string enums and `MetadataType`'s numbers were read out of Google's
//     shipped receiver framework (`cast_receiver_framework.js`);
//   * the field lists come from the published Cast SDK reference for
//     `chrome.cast.media.MediaInfo`, `.Track` and `.LoadRequest`.
//
// Two subtleties that the prose docs do not make obvious, and that a
// hand-written object literal would get wrong:
//
//   1. `HlsSegmentFormat` values are **lowercase** on the wire (`ts_aac`,
//      `e_ac3`, `fmp4`) even though the sender-side documentation writes them
//      in caps.
//   2. Sender and receiver disagree on the third `StreamType`: the sender SDK
//      documents `OTHER`, the receiver framework ships `NONE`. Both are
//      accepted here; we only ever send `BUFFERED`.

import { Schema } from "effect"

export const TrackType = Schema.Literals(["TEXT", "AUDIO", "VIDEO"])
export type TrackType = typeof TrackType.Type

export const TextTrackType = Schema.Literals([
  "SUBTITLES",
  "CAPTIONS",
  "DESCRIPTIONS",
  "CHAPTERS",
  "METADATA"
])
export type TextTrackType = typeof TextTrackType.Type

export const StreamType = Schema.Literals(["BUFFERED", "LIVE", "OTHER", "NONE"])
export type StreamType = typeof StreamType.Type

export const PlayerState = Schema.Literals(["IDLE", "PLAYING", "PAUSED", "BUFFERING"])
export type PlayerState = typeof PlayerState.Type

export const IdleReason = Schema.Literals(["CANCELLED", "INTERRUPTED", "FINISHED", "ERROR"])
export type IdleReason = typeof IdleReason.Type

/** Numeric on the wire, unlike every other enum here. */
export const MetadataType = {
  GENERIC: 0,
  MOVIE: 1,
  TV_SHOW: 2,
  MUSIC_TRACK: 3,
  PHOTO: 4,
  AUDIOBOOK_CHAPTER: 5
} as const

export const HlsSegmentFormat = Schema.Literals(["ts_aac", "ts_he_aac", "e_ac3", "fmp4"])
export type HlsSegmentFormat = typeof HlsSegmentFormat.Type

/**
 * An out-of-band text track.
 *
 * `language` is not optional in practice: the reference states it is
 * "Mandatory when the subtype is SUBTITLES", and a receiver handed a subtitle
 * track without one **ignores it silently** — no error, no subtitles. Requiring
 * it here turns that into a compile error.
 */
export class Track extends Schema.Class<Track>("Track")({
  trackId: Schema.Number,
  type: TrackType,
  trackContentId: Schema.optional(Schema.String),
  /** Recommended whenever trackContentId is set, e.g. `text/vtt`. */
  trackContentType: Schema.optional(Schema.String),
  subtype: Schema.optional(TextTrackType),
  /** RFC 5646 language tag. */
  language: Schema.String,
  name: Schema.optional(Schema.String)
}) {}

export class MediaInformation extends Schema.Class<MediaInformation>("MediaInformation")({
  contentId: Schema.String,
  contentType: Schema.String,
  streamType: StreamType,
  /** Null is legitimate for LIVE streams. */
  duration: Schema.optional(Schema.Number),
  /** `contentUrl` wins when present, freeing contentId to be a real identifier. */
  contentUrl: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
  tracks: Schema.optional(Schema.Array(Track)),
  hlsSegmentFormat: Schema.optional(HlsSegmentFormat),
  customData: Schema.optional(Schema.Unknown)
}) {}

export class LoadRequest extends Schema.Class<LoadRequest>("LoadRequest")({
  type: Schema.tag("LOAD"),
  requestId: Schema.Number,
  sessionId: Schema.optional(Schema.String),
  media: MediaInformation,
  autoplay: Schema.optional(Schema.Boolean),
  /** Seconds from the start of the content. */
  currentTime: Schema.optional(Schema.Number),
  activeTrackIds: Schema.optional(Schema.Array(Schema.Number)),
  customData: Schema.optional(Schema.Unknown)
}) {}

/**
 * Turning a text track on is a separate message: `activeTrackIds` in LOAD is
 * not reliably honoured, and sending this with an empty list is also how a
 * previously rendered track gets cleared before a reload.
 */
export class EditTracksInfoRequest
  extends Schema.Class<EditTracksInfoRequest>("EditTracksInfoRequest")({
    type: Schema.tag("EDIT_TRACKS_INFO"),
    requestId: Schema.Number,
    mediaSessionId: Schema.Number,
    activeTrackIds: Schema.optional(Schema.Array(Schema.Number)),
    textTrackStyle: Schema.optional(Schema.Unknown)
  })
{}

export const encodeLoad = Schema.encodeEffect(LoadRequest)
export const encodeEditTracks = Schema.encodeEffect(EditTracksInfoRequest)
