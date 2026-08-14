// Schemas for the payloads we care about.
//
// The receiver sends a great deal more than this; each schema declares only the
// fields we actually act on, so an unrelated change on the device side cannot
// break decoding. Every payload arrives as a JSON string, so `fromJsonString`
// handles parsing and validation together and a malformed frame degrades to
// `None` instead of throwing.

import { Schema } from "effect"
import { InboundType, PlayerState } from "./Namespace.ts"

/** Just enough to route a frame. */
export const Envelope = Schema.Struct({ type: Schema.String })
export type Envelope = typeof Envelope.Type

export const Application = Schema.Struct({
  appId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  transportId: Schema.optional(Schema.String)
})

export const ReceiverStatus = Schema.Struct({
  type: Schema.String,
  status: Schema.optional(Schema.Struct({
    applications: Schema.optional(Schema.Array(Application)),
    volume: Schema.optional(Schema.Struct({
      level: Schema.optional(Schema.Number),
      muted: Schema.optional(Schema.Boolean)
    }))
  }))
})
export type ReceiverStatus = typeof ReceiverStatus.Type

export const MediaStatusEntry = Schema.Struct({
  mediaSessionId: Schema.optional(Schema.Number),
  playerState: Schema.optional(PlayerState),
  currentTime: Schema.optional(Schema.Number),
  idleReason: Schema.optional(Schema.String)
})

export const MediaStatus = Schema.Struct({
  type: Schema.String,
  status: Schema.optional(Schema.Array(MediaStatusEntry))
})
export type MediaStatus = typeof MediaStatus.Type

/** Decoders over the raw payload string. */
export const decodeEnvelope = Schema.decodeOption(Schema.fromJsonString(Envelope))
export const decodeReceiverStatus = Schema.decodeOption(Schema.fromJsonString(ReceiverStatus))
export const decodeMediaStatus = Schema.decodeOption(Schema.fromJsonString(MediaStatus))

export { InboundType, PlayerState }
