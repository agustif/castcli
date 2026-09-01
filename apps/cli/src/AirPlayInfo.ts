// GET /info body + pairing-prelude policy.
//
// Apple TV: POST /pair-pin-start on the keep-alive socket, then HAP pair-setup.
// macOS AirPlay Receiver: /pair-pin-start is 403 (not a PIN overlay). Sending it
// and then pair-setup on that socket is the wrong first request. Policy comes
// from /info `model` (always present) so an IP shortcut without TXT still works.

import { Match, Option, Schema } from "effect"
import { describeAirPlayAccessControl, isMacAirPlayReceiver, wantsPairPinStart } from "@castcli/domain"
import * as bplist from "./bplist.ts"

export interface AirPlayInfo {
  readonly model: string | undefined
  readonly name: string | undefined
  readonly deviceID: string | undefined
  readonly statusFlags: number | undefined
  readonly features: number | undefined
}

const empty: AirPlayInfo = {
  model: undefined,
  name: undefined,
  deviceID: undefined,
  statusFlags: undefined,
  features: undefined
}

const InfoFields = Schema.Struct({
  model: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  deviceID: Schema.optional(Schema.String),
  statusFlags: Schema.optional(Schema.Number),
  features: Schema.optional(Schema.Number)
})

const decodePlist = Option.liftThrowable((bytes: Uint8Array) => bplist.decode(bytes))

export const parseAirPlayInfo = (body: Uint8Array): AirPlayInfo =>
  Match.value(body.byteLength === 0).pipe(
    Match.when(true, () => empty),
    Match.when(false, () =>
      Option.match(
        Option.flatMap(
          decodePlist(body),
          (decoded) => Schema.decodeUnknownOption(InfoFields)(decoded)
        ),
        {
          onNone: () => empty,
          onSome: (info) => ({
            model: info.model,
            name: info.name,
            deviceID: info.deviceID,
            statusFlags: info.statusFlags,
            features: info.features
          })
        }
      )
    ),
    Match.exhaustive
  )

export const pairPinStartFromInfo = (info: AirPlayInfo): boolean => wantsPairPinStart(info.model)

export const describePairSetupRefusal = (options: {
  readonly infoStatus: number
  readonly infoBytes: number
  readonly pinStartStatus: number | undefined
  readonly m2Status: number
  readonly m2Bytes: number
  readonly host: string
  readonly model: string | undefined
  readonly act: string | undefined
  readonly skippedPinStart: boolean
}): string => {
  const access = describeAirPlayAccessControl(options.act)
  const mac = isMacAirPlayReceiver(options.model)
  const pin = Match.value({
    status: options.pinStartStatus,
    skipped: options.skippedPinStart
  }).pipe(
    Match.when({ status: undefined, skipped: true }, () => "pair-pin-start skipped (not an Apple TV PIN overlay)"),
    Match.when({ status: undefined, skipped: false }, () => "pair-pin-start not sent"),
    Match.orElse((row) => `pair-pin-start HTTP ${row.status}`)
  )
  const acl = access === undefined ? "" : `, act=${options.act} ${access}`
  const hint = Match.value(mac).pipe(
    Match.when(
      true,
      () =>
        " macOS AirPlay Receiver does not use HAP pair-pin-start; pair-setup 403 is the receiver ACL (Allow AirPlay for Current User only admits Apple Account devices, not this sender)."
    ),
    Match.when(false, () => " need HTTP 200 and a HAP TLV body."),
    Match.exhaustive
  )
  return (
    `pair-setup M2 refused: GET /info HTTP ${options.infoStatus} ${options.infoBytes} bytes, ` +
    `${pin}, pair-setup M2 HTTP ${options.m2Status} ${options.m2Bytes} bytes ` +
    `(Host ${options.host}, model ${options.model ?? "unknown"}${acl}).${hint}`
  )
}
