// PlaybackInfo plist parsing with Effect Schema and fast-xml-parser.
//
// Replaces regex scraping with proper XML or binary plist decoding. Returns
// a typed result or fails with a domain error on garbage input.

import { Effect, Option, Schema } from "effect"
import { XMLParser, XMLValidator } from "fast-xml-parser"
import { parseBinary } from "plist"

/**
 * Parse Error: the playback-info response is not valid XML plist.
 *
 * Raised when the response body is malformed XML or does not match the
 * expected plist structure. This is a decode failure, not a transport
 * failure: the device replied, but the reply cannot be parsed.
 */
export class MalformedPlaybackInfo extends Schema.TaggedError<MalformedPlaybackInfo>()(
  "AirPlayMalformedPlaybackInfo",
  {
    /** Brief reason why decoding failed */
    reason: Schema.String
  }
) {
  override get message(): string {
    return `playback-info: ${this.reason}`
  }
}

/**
 * One parser configured for Apple's plist conventions.
 *
 * - `removeNSPrefix`: strip namespace prefixes so `plist:dict` becomes `dict`
 * - `parseTagValue: false`: keep numbers as strings to avoid lossy conversion
 * - `ignoreAttributes`: attributes carry nothing in plist beyond version
 * - `trimValues`: whitespace around values is formatting, not content
 */
const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreAttributes: true,
  trimValues: true
})

/**
 * Parse XML string to document or None if malformed.
 */
const parseDocument = (xml: string): Option.Option<unknown> =>
  XMLValidator.validate(xml) === true ? Option.some(parser.parse(xml)) : Option.none()

/**
 * Plist dict entry: <key>name</key><type>value</type>
 *
 * Apple plist uses alternating key/value elements. The parser represents
 * dict contents as `{ key: [...names], type: [...values] }` where type
 * is `real`, `true`, `false`, `string`, etc.
 */
const PlistDict = Schema.Struct({
  plist: Schema.Struct({
    dict: Schema.Record(Schema.String, Schema.Unknown)
  })
})

const decodePlistDict = Schema.decodeUnknownOption(PlistDict)

/**
 * Normalize keys to always be an array.
 *
 * fast-xml-parser returns a string for single elements, array for multiple.
 */
const normalizeKeys = (keys: unknown): ReadonlyArray<string> =>
  Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : []

/**
 * Extract a real value by key from plist dict.
 *
 * Plist structure is `{ key: ["duration", "position"], real: ["120.5", "42.0"] }`.
 * This finds the index of the key name in the `key` array and returns the
 * corresponding value from the `real` array.
 */
const extractReal = (dict: Record<string, unknown>, keyName: string): Option.Option<number> => {
  const keys = normalizeKeys(dict["key"])
  const reals = dict["real"]
  const realsArray = Array.isArray(reals) ? reals : typeof reals === "string" ? [reals] : []
  
  const index = keys.indexOf(keyName)
  return Option.flatMap(
    index >= 0 && index < realsArray.length ? Option.some(realsArray[index]) : Option.none(),
    (value) => typeof value === "string" ? Option.some(Number(value)) : Option.none()
  )
}

/**
 * Extract a boolean value by key from plist dict.
 *
 * Plist booleans are `<true />` or `<false />` tags. The parser represents them
 * as `{ key: ["readyToPlay"], true: "" }` or `{ key: ["readyToPlay"], false: "" }`.
 * The boolean tag appears after all the real values in the key array.
 */
const extractBoolean = (dict: Record<string, unknown>, keyName: string): Option.Option<boolean> => {
  const keys = normalizeKeys(dict["key"])
  const index = keys.indexOf(keyName)
  
  return Option.flatMap(
    index >= 0 ? Option.some(index) : Option.none(),
    (idx) => {
      const reals = dict["real"]
      const realCount = Array.isArray(reals) ? reals.length : typeof reals === "string" ? 1 : 0
      
      return idx >= realCount
        ? Option.match(
          Option.fromNullishOr(dict["true"]),
          {
            onNone: () => Option.match(
              Option.fromNullishOr(dict["false"]),
              {
                onNone: () => Option.none(),
                onSome: () => Option.some(false)
              }
            ),
            onSome: () => Option.some(true)
          }
        )
        : Option.none()
    }
  )
}

/**
 * Decoded playback-info fields.
 *
 * All fields are optional because the device may omit any of them depending
 * on playback state. Absence is represented as `undefined`, not `Option.none`.
 */
export interface PlaybackInfo {
  readonly duration: number | undefined
  readonly position: number | undefined
  readonly rate: number | undefined
  readonly readyToPlay: boolean | undefined
}

/**
 * Detect if input is binary plist (bplist00 magic header).
 */
const isBinaryPlist = (input: string | Uint8Array): boolean =>
  typeof input === "string"
    ? input.startsWith("bplist00")
    : (() => {
      const header = new Uint8Array(input.slice(0, 8))
      return (
        header[0] === 98 && // b
        header[1] === 112 && // p
        header[2] === 108 && // l
        header[3] === 105 && // i
        header[4] === 115 && // s
        header[5] === 116 && // t
        header[6] === 48 && // 0
        header[7] === 48 // 0
      )
    })()

/**
 * Schema for binary plist dictionary result.
 */
const BinaryPlistDict = Schema.Record(Schema.String, Schema.Unknown)

/**
 * Parse binary plist to dict Effect.
 */
const parseBinaryPlistEffect = (
  input: string | Uint8Array
): Effect.Effect<Record<string, unknown>, MalformedPlaybackInfo> =>
  Effect.gen(function* () {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input)
    const result = yield* Effect.try({
      try: () => parseBinary(bytes),
      catch: () => new MalformedPlaybackInfo({ reason: "not a valid binary plist" })
    })
    return yield* Option.match(Schema.decodeUnknownOption(BinaryPlistDict)(result), {
      onNone: () => Effect.fail(new MalformedPlaybackInfo({ reason: "binary plist is not a dict" })),
      onSome: (dict) => Effect.succeed(dict)
    })
  })

/**
 * Extract PlaybackInfo fields from a parsed plist dictionary.
 *
 * For binary plists, fields are directly accessed as native types.
 * For XML plists, fields are extracted from the plist structure using
 * the extractReal and extractBoolean helpers.
 */
const extractPlaybackInfo = (dict: Record<string, unknown>, isXml = false): PlaybackInfo =>
  isXml
    ? {
      duration: Option.getOrUndefined(extractReal(dict, "duration")),
      position: Option.getOrUndefined(extractReal(dict, "position")),
      rate: Option.getOrUndefined(extractReal(dict, "rate")),
      readyToPlay: Option.getOrUndefined(extractBoolean(dict, "readyToPlay"))
    }
    : {
      duration: typeof dict["duration"] === "number" ? dict["duration"] : undefined,
      position: typeof dict["position"] === "number" ? dict["position"] : undefined,
      rate: typeof dict["rate"] === "number" ? dict["rate"] : undefined,
      readyToPlay: typeof dict["readyToPlay"] === "boolean" ? dict["readyToPlay"] : undefined
    }

/**
 * Parse GET /playback-info plist response (XML or binary).
 *
 * Decodes the response body with Effect Schema for XML or the plist library
 * for binary plists. Returns PlaybackInfo with defined fields for values
 * present in the plist, or fails with MalformedPlaybackInfo on malformed
 * input or unexpected structure.
 *
 * Binary plists are auto-detected by the bplist00 magic header. XML plists
 * are parsed with fast-xml-parser.
 *
 * @example
 * ```ts
 * const xml = `<?xml version="1.0"?>
 * <plist version="1.0">
 * <dict>
 *   <key>duration</key><real>120.5</real>
 *   <key>position</key><real>42.0</real>
 *   <key>rate</key><real>1</real>
 *   <key>readyToPlay</key><true />
 * </dict>
 * </plist>`
 * 
 * const info = parse(xml)
 * // => { duration: 120.5, position: 42.0, rate: 1, readyToPlay: true }
 * ```
 */
export const parse = (input: string | Uint8Array): Effect.Effect<PlaybackInfo, MalformedPlaybackInfo> =>
  isBinaryPlist(input)
    ? Effect.map(parseBinaryPlistEffect(input), (dict) => extractPlaybackInfo(dict, false))
    : typeof input === "string"
      ? Option.match(parseDocument(input), {
        onNone: () => Effect.fail(new MalformedPlaybackInfo({ reason: "not valid XML" })),
        onSome: (document) =>
          Option.match(decodePlistDict(document), {
            onNone: () => Effect.fail(new MalformedPlaybackInfo({ reason: "not a plist dict" })),
            onSome: (plist) => Effect.succeed(extractPlaybackInfo(plist.plist.dict, true))
          })
      })
      : Effect.fail(new MalformedPlaybackInfo({ reason: "input must be string or Uint8Array" }))
