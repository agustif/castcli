// Generated from the Cast receiver framework. Do not edit.
//
// Source:  https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js
// sha256:  46a78cb0f18957427a737ccc1015dfd1a587c7558ec66df0ff477f5579ef8ea0
//
// These are the values a Cast device itself ships, which is not always what
// the prose documentation says: `HlsSegmentFormat` is written in caps there
// and lowercase here, and the sender SDK documents a third `StreamType` the
// receiver spells differently.
//
//   npm run vocabulary:sync   refetch from Google and update the snapshot
//   npm run codegen           regenerate this file from the snapshot

import { Schema } from "effect"

/** Player states the receiver reports. */
export const PlayerState = Schema.Literals([
  "BUFFERING",
  "IDLE",
  "PAUSED",
  "PLAYING"
])
export type PlayerState = typeof PlayerState.Type

/** What the receiver application itself is doing. Lowercase on the wire. */
export const ApplicationState = Schema.Literals([
  "buffering",
  "idle",
  "launching",
  "loading",
  "paused",
  "playing"
])
export type ApplicationState = typeof ApplicationState.Type

/** How the receiver should treat the stream's timeline. */
export const StreamType = Schema.Literals([
  "BUFFERED",
  "LIVE",
  "NONE"
])
export type StreamType = typeof StreamType.Type

/** Audio encoding of an HLS segment. Lowercase on the wire. */
export const HlsSegmentFormat = Schema.Literals([
  "aac",
  "ac3",
  "e_ac3",
  "fmp4",
  "mp3",
  "ts",
  "ts_aac",
  "ts_he_aac"
])
export type HlsSegmentFormat = typeof HlsSegmentFormat.Type

/** Container of an HLS video segment. */
export const HlsVideoSegmentFormat = Schema.Literals([
  "fmp4",
  "mpeg2_ts"
])
export type HlsVideoSegmentFormat = typeof HlsVideoSegmentFormat.Type

/** What kind of media a track carries. */
export const TrackType = Schema.Literals([
  "AUDIO",
  "TEXT",
  "VIDEO"
])
export type TrackType = typeof TrackType.Type

/** What a text track is for. SUBTITLES needs a language. */
export const TextTrackType = Schema.Literals([
  "CAPTIONS",
  "CHAPTERS",
  "DESCRIPTIONS",
  "METADATA",
  "SUBTITLES"
])
export type TextTrackType = typeof TextTrackType.Type

/** Content types the receiver accepts for a text track. */
export const CaptionMimeType = Schema.Literals([
  "application/mp4",
  "application/ttml+xml",
  "text/cea608",
  "text/vtt"
])
export type CaptionMimeType = typeof CaptionMimeType.Type

/** Why the receiver went idle — how a finished film is told from a failure. */
export const IdleReason = Schema.Literals([
  "CANCELLED",
  "ERROR",
  "FINISHED",
  "INTERRUPTED"
])
export type IdleReason = typeof IdleReason.Type

/** How a rejected request is described. */
export const ErrorType = Schema.Literals([
  "ERROR",
  "INVALID_PLAYER_STATE",
  "INVALID_REQUEST",
  "LOAD_CANCELLED",
  "LOAD_FAILED"
])
export type ErrorType = typeof ErrorType.Type

/** Queue repeat behaviour. */
export const RepeatMode = Schema.Literals([
  "REPEAT_ALL",
  "REPEAT_ALL_AND_SHUFFLE",
  "REPEAT_OFF",
  "REPEAT_SINGLE"
])
export type RepeatMode = typeof RepeatMode.Type

/** Dynamic range of the video a device reports being able to show. */
export const HdrType = Schema.Literals([
  "dv",
  "hdr",
  "sdr"
])
export type HdrType = typeof HdrType.Type
