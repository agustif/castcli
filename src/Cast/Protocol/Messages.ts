// Schemas for the payloads we care about.
//
// The receiver sends a great deal more than this; each schema declares only the
// fields we actually act on, so an unrelated change on the device side cannot
// break decoding. Every payload arrives as a JSON string, so `fromJsonString`
// handles parsing and validation together and a malformed frame degrades to
// `None` instead of throwing.
//
// Only the decoders are exported. The schemas themselves are an implementation
// detail of this module: exporting them invited callers to re-decode payloads
// that have already been routed.

import { Schema } from "effect"
import { PlayerState } from "./Namespace.ts"

/**
 * Just enough to route a frame.
 *
 * `type` is deliberately a plain string rather than the closed `InboundType`
 * set: this schema decides *whether we recognise* a message, and a device
 * sending something new should fall through to the router's catch-all rather
 * than fail to decode. The closed set belongs at the point of dispatch.
 */
const Envelope = Schema.Struct({ type: Schema.String })

const Application = Schema.Struct({
  appId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  transportId: Schema.optional(Schema.String)
})

const ReceiverStatus = Schema.Struct({
  type: Schema.String,
  status: Schema.optional(Schema.Struct({
    applications: Schema.optional(Schema.Array(Application)),
    volume: Schema.optional(Schema.Struct({
      level: Schema.optional(Schema.Number),
      muted: Schema.optional(Schema.Boolean)
    }))
  }))
})

const MediaStatusEntry = Schema.Struct({
  mediaSessionId: Schema.optional(Schema.Number),
  /** Closed set here, because we branch on it. */
  playerState: Schema.optional(PlayerState),
  currentTime: Schema.optional(Schema.Number),
  idleReason: Schema.optional(Schema.String)
})

const MediaStatus = Schema.Struct({
  type: Schema.String,
  status: Schema.optional(Schema.Array(MediaStatusEntry))
})

/** Decoders over the raw payload string. */
export const decodeEnvelope = Schema.decodeOption(Schema.fromJsonString(Envelope))
export const decodeReceiverStatus = Schema.decodeOption(Schema.fromJsonString(ReceiverStatus))
export const decodeMediaStatus = Schema.decodeOption(Schema.fromJsonString(MediaStatus))
