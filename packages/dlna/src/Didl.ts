// DIDL-Lite: the metadata a renderer is handed alongside the URL.
//
// `SetAVTransportURI` takes two arguments, the URL and a metadata document
// describing what is at it, and televisions treat the second one as load
// bearing rather than as decoration. A missing or malformed document is why a
// set answers the action happily and then shows a black screen, or plays but
// titles the programme with its own URL and offers no seek bar. The renderer
// has no other source for the duration, the content type or the title.
//
// The document has a fixed shape, so it is assembled as text rather than
// through a builder. That is only safe because every interpolated value goes
// through `escape` first — a film title containing `&` is ordinary, and an
// unescaped one makes the whole document unparseable, which reads to the
// caller as the television rejecting a perfectly good file.

import { Option } from "effect"

export interface VideoItem {
  readonly title: string
  readonly url: string
  readonly contentType: string
  readonly durationSeconds: Option.Option<number>
  /** A sidecar subtitle URL, which some renderers honour. */
  readonly subtitleUrl: Option.Option<string>
}

/**
 * The four namespaces the document declares.
 *
 * `dc` carries the title and `upnp` the class; both are mandatory and a
 * document missing either is rejected outright. `sec` is Samsung's own
 * namespace — declared even when there is no subtitle, because declaring a
 * namespace costs nothing and adding it conditionally means two documents to
 * reason about instead of one.
 */
const NAMESPACES = [
  `xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"`,
  `xmlns:dc="http://purl.org/dc/elements/1.1/"`,
  `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"`,
  `xmlns:sec="http://www.sec.co.kr/"`
].join(" ")

/**
 * What we are sending. An item with no `upnp:class`, or one classed as
 * `object.item` alone, is widely refused: the renderer uses the class to pick
 * which of its players to hand the stream to, so an unclassed item has nowhere
 * to go.
 */
const VIDEO_CLASS = "object.item.videoItem"

/**
 * `DLNA.ORG_OP` is two binary digits: the first says we answer a
 * `TimeSeekRange.dlna.org` request, the second that we answer an HTTP `Range`
 * one. `01` therefore advertises byte-range seeking only, which is what an
 * ordinary static file server does and what makes the television draw a seek
 * bar at all. Claiming `10` or `11` without implementing the time-seek header
 * is worse than claiming nothing: the set sends `TimeSeekRange.dlna.org`, gets
 * a response that ignores it, and either stalls or restarts from zero.
 */
const OPERATIONS = "DLNA.ORG_OP=01"

/**
 * The primary flags word, `0x01700000` followed by the 24 reserved zero bytes
 * the syntax requires. It sets streaming transfer mode (bit 24), background
 * transfer mode (bit 22), connection-stall (bit 21) and DLNA v1.5 (bit 20).
 *
 * Streaming transfer mode is the one that matters: it tells the renderer to
 * treat the response as a stream it consumes at playback rate rather than a
 * file it must download before starting, which is the difference between
 * playback beginning in a second and a set sitting on a spinner for minutes.
 */
const FLAGS = "DLNA.ORG_FLAGS=01700000000000000000000000000000"

/** The `res@protocolInfo` value for something we serve over plain HTTP. */
export const protocolInfo = (contentType: string): string =>
  `http-get:*:${contentType}:${OPERATIONS};${FLAGS}`

/**
 * Sidecar subtitles are served as SRT rather than WebVTT because that is what
 * `sec:CaptionInfoEx` names and what the sets that read it can decode.
 */
const SUBTITLE_PROTOCOL_INFO = "http-get:*:text/srt:*"

/**
 * XML escaping, applied to every interpolated value without exception.
 *
 * `&` is replaced first, or the ampersands introduced by the later
 * replacements would themselves be escaped and `<` would come out as `&amp;lt;`.
 * Quotes are escaped too because the same function is used for attribute
 * values, where an unescaped quote ends the attribute early.
 */
const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&quot;")
    .replaceAll(`'`, "&apos;")

const pad = (value: number, width: number): string => String(value).padStart(width, "0")

/**
 * `res@duration` in the `H:MM:SS.mmm` form UPnP asks for: hours unpadded,
 * everything after it fixed width.
 *
 * The arithmetic runs in whole milliseconds rather than on the fractional
 * seconds, because rounding the fraction separately can produce 1000 ms and
 * with it a duration ending `:59.1000`, which a renderer reads as garbage and
 * then reports no duration at all.
 */
const formatDuration = (seconds: number): string => {
  const total = Math.round(Math.max(0, seconds) * 1000)
  return [
    `${Math.floor(total / 3_600_000)}`,
    pad(Math.floor(total / 60_000) % 60, 2),
    `${pad(Math.floor(total / 1000) % 60, 2)}.${pad(total % 1000, 3)}`
  ].join(":")
}

/**
 * Duration is an attribute rather than an element, and it is omitted entirely
 * when unknown: `duration="0:00:00.000"` is not "unknown", it is a claim that
 * the programme is empty, and a renderer that believes it ends playback at
 * once.
 */
const durationAttribute = (durationSeconds: Option.Option<number>): string =>
  Option.match(durationSeconds, {
    onNone: () => "",
    onSome: (seconds) => ` duration="${escape(formatDuration(seconds))}"`
  })

/**
 * Samsung and LG take a sidecar subtitle track two ways at once, and both are
 * needed: `sec:CaptionInfoEx` is what the firmware looks for when deciding
 * that subtitles exist, and the second `<res>` is where it goes to fetch them.
 * Either one alone leaves the caption menu empty.
 */
const subtitleElements = (subtitleUrl: Option.Option<string>): ReadonlyArray<string> =>
  Option.match(subtitleUrl, {
    onNone: (): ReadonlyArray<string> => [],
    onSome: (url) => [
      `<sec:CaptionInfoEx sec:type="srt">${escape(url)}</sec:CaptionInfoEx>`,
      `<res protocolInfo="${escape(SUBTITLE_PROTOCOL_INFO)}">${escape(url)}</res>`
    ]
  })

/**
 * A DIDL-Lite document describing one video item.
 *
 * `parentID="-1"` and `restricted="1"` say the item belongs to no container
 * and cannot be edited by the renderer, which is the truth for something we
 * are pushing at it rather than something it browsed to, and is what every
 * control point sends for a pushed item.
 */
export const videoItem = (item: VideoItem): string =>
  [
    `<DIDL-Lite ${NAMESPACES}>`,
    `<item id="0" parentID="-1" restricted="1">`,
    `<dc:title>${escape(item.title)}</dc:title>`,
    `<upnp:class>${VIDEO_CLASS}</upnp:class>`,
    `<res protocolInfo="${escape(protocolInfo(item.contentType))}"` +
      `${durationAttribute(item.durationSeconds)}>${escape(item.url)}</res>`,
    ...subtitleElements(item.subtitleUrl),
    `</item>`,
    `</DIDL-Lite>`
  ].join("")
