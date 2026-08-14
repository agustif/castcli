// Cast protocol namespaces and message types, as literal schemas.
//
// These were bare strings scattered through the session code. As
// `Schema.Literals` they are a closed set: a typo is a compile error, and the
// same declaration validates inbound frames.

import { Schema } from "effect"

/**
 * One TLS socket multiplexes several "virtual connections", each addressed by a
 * destination id and scoped to a namespace.
 */
export const Namespace = Schema.Literals([
  "urn:x-cast:com.google.cast.tp.connection",
  "urn:x-cast:com.google.cast.tp.heartbeat",
  "urn:x-cast:com.google.cast.receiver",
  "urn:x-cast:com.google.cast.media"
])
export type Namespace = typeof Namespace.Type

export const Connection: Namespace = "urn:x-cast:com.google.cast.tp.connection"
export const Heartbeat: Namespace = "urn:x-cast:com.google.cast.tp.heartbeat"
export const Receiver: Namespace = "urn:x-cast:com.google.cast.receiver"
export const Media: Namespace = "urn:x-cast:com.google.cast.media"

/** The stock receiver app. Anything else needs a registered application id. */
export const DEFAULT_MEDIA_RECEIVER = "CC1AD845"

/** Well-known endpoints. `receiver-0` always exists; the media transport id is assigned per session. */
export const SENDER_ID = "sender-0"
export const RECEIVER_ID = "receiver-0"

/** Inbound message types we act on. */
export const InboundType = Schema.Literals([
  "PING",
  "PONG",
  "RECEIVER_STATUS",
  "MEDIA_STATUS",
  "LOAD_FAILED",
  "LOAD_CANCELLED",
  "INVALID_REQUEST"
])
export type InboundType = typeof InboundType.Type

/**
 * Commands we may send on the media namespace. A closed set, so a typo is a
 * compile error rather than a message the receiver silently discards.
 */
export const MediaCommand = Schema.Literals([
  "PLAY",
  "PAUSE",
  "STOP",
  "SEEK",
  "GET_STATUS",
  "EDIT_TRACKS_INFO"
])
export type MediaCommand = typeof MediaCommand.Type

/**
 * Player states the receiver reports. `BUFFERING` is the one that matters most:
 * it is the only unambiguous evidence that the current bitrate does not fit.
 */
export const PlayerState = Schema.Literals([
  "IDLE",
  "BUFFERING",
  "PLAYING",
  "PAUSED",
  "LOADING"
])
export type PlayerState = typeof PlayerState.Type
