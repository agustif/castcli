// GENERATED — do not edit.
//
// Source: packages/protocol/proto/cast_channel.proto (Chromium, BSD-licensed).
// Regenerate with `npm run codegen`; `npm run codegen:check` fails if stale.
//
// Wire keys are derived, not transcribed: key = (fieldNumber << 3) | wireType,
// where wireType is 0 for varints and 2 for length-delimited values.

export interface FieldDescriptor {
  readonly number: number
  readonly wire: "varint" | "length"
  readonly rule: string
  readonly type: string
  readonly key: number
}

export const CastMessageFields = {
  protocol_version: {
    number: 1,
    wire: "varint",
    rule: "required",
    type: "ProtocolVersion",
    /** (1 << 3) | 0 */
    key: 0x8
  },
  source_id: {
    number: 2,
    wire: "length",
    rule: "required",
    type: "string",
    /** (2 << 3) | 2 */
    key: 0x12
  },
  destination_id: {
    number: 3,
    wire: "length",
    rule: "required",
    type: "string",
    /** (3 << 3) | 2 */
    key: 0x1a
  },
  namespace: {
    number: 4,
    wire: "length",
    rule: "required",
    type: "string",
    /** (4 << 3) | 2 */
    key: 0x22
  },
  payload_type: {
    number: 5,
    wire: "varint",
    rule: "required",
    type: "PayloadType",
    /** (5 << 3) | 0 */
    key: 0x28
  },
  payload_utf8: {
    number: 6,
    wire: "length",
    rule: "optional",
    type: "string",
    /** (6 << 3) | 2 */
    key: 0x32
  },
  payload_binary: {
    number: 7,
    wire: "length",
    rule: "optional",
    type: "bytes",
    /** (7 << 3) | 2 */
    key: 0x3a
  }
} as const satisfies Record<string, FieldDescriptor>

export type CastMessageField = keyof typeof CastMessageFields

/** Reverse lookup: field number to field name, for the decoder. */
export const byNumber: ReadonlyMap<number, CastMessageField> = new Map(
  Object.entries(CastMessageFields).map(([name, d]) => [d.number, name as CastMessageField])
)

export const ProtocolVersion = {
  CASTV2_1_0: 0
} as const

export const PayloadType = {
  STRING: 0,
  BINARY: 1
} as const
