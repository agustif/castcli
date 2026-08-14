// Wire format for the Google Cast v2 protocol: framing and the CastMessage
// protobuf.
//
// Frames are a 4-byte big-endian length prefix followed by a protobuf
// `CastMessage`. The field numbers and wire keys are **not** written here — they
// are generated from the vendored `cast_channel.proto` into `Generated.ts`, so
// the protobuf definition is the single source of truth and a change upstream
// shows up as a diff rather than as a device silently ignoring our messages.
//
// Both payload representations are supported. `payload_utf8` carries the JSON
// used by every namespace we speak; `payload_binary` is what the device
// authentication namespace (`urn:x-cast:com.google.cast.tp.deviceauth`) uses,
// and is present here so the codec covers the whole message rather than the
// half we happen to need.

import { Data, Match } from "effect"
import { byNumber, CastMessageFields as F, PayloadType } from "./Generated.ts"

/** Exactly one of the two payload fields is set, per the proto's comment. */
export type Payload = Data.TaggedEnum<{
  readonly Text: { readonly value: string }
  readonly Binary: { readonly value: Uint8Array }
}>

export const Payload = Data.taggedEnum<Payload>()

export interface CastMessage {
  readonly sourceId: string
  readonly destinationId: string
  readonly namespace: string
  readonly payload: Payload
}

/** Base-128 varint: low group first, high bit set on every group but the last. */
const encodeVarint = (value: number): ReadonlyArray<number> =>
  value < 0x80
    ? [value]
    : [(value & 0x7f) | 0x80, ...encodeVarint(value >>> 7)]

const readVarint = (
  buf: Buffer,
  offset: number,
  shift = 0,
  acc = 0
): readonly [value: number, next: number] => {
  const byte = buf[offset] ?? 0
  const value = acc | ((byte & 0x7f) << shift)
  return (byte & 0x80) === 0
    ? [value >>> 0, offset + 1] as const
    : readVarint(buf, offset + 1, shift + 7, value)
}

const lengthDelimited = (key: number, bytes: Buffer): Buffer =>
  Buffer.concat([Buffer.from([key]), Buffer.from(encodeVarint(bytes.length)), bytes])

const varintField = (key: number, value: number): Buffer =>
  Buffer.concat([Buffer.from([key]), Buffer.from(encodeVarint(value))])

/** `payload_type` and which field carries the bytes move together. */
const encodePayload: (payload: Payload) => Buffer = Match.type<Payload>().pipe(
  Match.tag("Text", ({ value }) =>
    Buffer.concat([
      varintField(F.payload_type.key, PayloadType.STRING),
      lengthDelimited(F.payload_utf8.key, Buffer.from(value, "utf8"))
    ])),
  Match.tag("Binary", ({ value }) =>
    Buffer.concat([
      varintField(F.payload_type.key, PayloadType.BINARY),
      lengthDelimited(F.payload_binary.key, Buffer.from(value))
    ])),
  Match.exhaustive
)

/** Encode a message including its length prefix, ready to write to the socket. */
export const encodeFrame = (message: CastMessage): Buffer => {
  const body = Buffer.concat([
    varintField(F.protocol_version.key, 0), // CASTV2_1_0
    lengthDelimited(F.source_id.key, Buffer.from(message.sourceId, "utf8")),
    lengthDelimited(F.destination_id.key, Buffer.from(message.destinationId, "utf8")),
    lengthDelimited(F.namespace.key, Buffer.from(message.namespace, "utf8")),
    encodePayload(message.payload)
  ])
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(body.length)
  return Buffer.concat([prefix, body])
}

/**
 * Decoded fields are collected loosely and resolved at the end, because
 * `payload_type` may arrive before or after the payload itself.
 */
interface Partial_ {
  readonly sourceId: string
  readonly destinationId: string
  readonly namespace: string
  readonly payloadType: number
  readonly text: string
  readonly binary: Uint8Array
}

const EMPTY: Partial_ = {
  sourceId: "",
  destinationId: "",
  namespace: "",
  payloadType: PayloadType.STRING,
  text: "",
  binary: new Uint8Array(0)
}

const assign = (
  acc: Partial_,
  field: number,
  value: { readonly bytes?: Buffer; readonly number?: number }
): Partial_ =>
  Match.value(byNumber.get(field)).pipe(
    Match.when("source_id", () => ({ ...acc, sourceId: value.bytes?.toString("utf8") ?? "" })),
    Match.when("destination_id", () => ({
      ...acc,
      destinationId: value.bytes?.toString("utf8") ?? ""
    })),
    Match.when("namespace", () => ({ ...acc, namespace: value.bytes?.toString("utf8") ?? "" })),
    Match.when("payload_type", () => ({ ...acc, payloadType: value.number ?? 0 })),
    Match.when("payload_utf8", () => ({ ...acc, text: value.bytes?.toString("utf8") ?? "" })),
    Match.when("payload_binary", () => ({
      ...acc,
      binary: new Uint8Array(value.bytes ?? Buffer.alloc(0))
    })),
    Match.orElse(() => acc)
  )

const decodeFields = (buf: Buffer, offset: number, acc: Partial_): Partial_ =>
  offset >= buf.length ? acc : Match.value((buf[offset] ?? 0) & 7).pipe(
    Match.when(0, () => {
      const [value, next] = readVarint(buf, offset + 1)
      return decodeFields(buf, next, assign(acc, (buf[offset] ?? 0) >> 3, { number: value }))
    }),
    Match.when(2, () => {
      const [length, start] = readVarint(buf, offset + 1)
      return decodeFields(
        buf,
        start + length,
        assign(acc, (buf[offset] ?? 0) >> 3, { bytes: buf.subarray(start, start + length) })
      )
    }),
    // We neither send nor expect any other wire type; stop rather than guess.
    Match.orElse(() => acc)
  )

export const decodeMessage = (buf: Buffer): CastMessage => {
  const parts = decodeFields(buf, 0, EMPTY)
  return {
    sourceId: parts.sourceId,
    destinationId: parts.destinationId,
    namespace: parts.namespace,
    payload: parts.payloadType === PayloadType.BINARY
      ? Payload.Binary({ value: parts.binary })
      : Payload.Text({ value: parts.text })
  }
}

/**
 * Split a rolling buffer into complete frames, returning the frames and any
 * partial bytes left for the next read. Cast frames do not align with TCP
 * reads, so the remainder always matters.
 */
export const takeFrames = (
  buffer: Buffer,
  acc: ReadonlyArray<CastMessage> = []
): readonly [ReadonlyArray<CastMessage>, Buffer] =>
  buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)
    ? takeFrames(buffer.subarray(4 + buffer.readUInt32BE(0)), [
      ...acc,
      decodeMessage(buffer.subarray(4, 4 + buffer.readUInt32BE(0)))
    ])
    : [acc, buffer] as const
