// SSDP: asking every device on the wire to identify itself, and reading the
// answers.
//
// Discovery is one UDP datagram multicast to 239.255.255.250:1900, and however
// many unicast replies happen to come back. A reply is HTTP-shaped but is not
// HTTP — it arrives whole in a datagram, has no body, and is answered by
// firmware that reads it with a hand-written parser. That is why the wording
// below is copied from the spec rather than improved upon: the quoting of
// `MAN`, the order of nothing in particular, the CRLF endings.
//
// The only load-bearing header in a reply is `LOCATION`, a URL to the device
// description XML. The datagram says almost nothing about what the box can do;
// it says where to go and read about it. Everything else here is context for
// logs and for deduplicating the three-or-more copies a device sends of every
// announcement.
//
// This module is text in, values out. Sockets live in the platform package, so
// that the part with the interesting failure modes — devices that answer in
// lower case, devices that answer `NOTIFY` to a search, devices that omit the
// one header that matters — can be tested against captures instead of against
// a television that replies when it feels like it.

import { Array, Option } from "effect"

/** The device type a television or receiver advertises. */
export const MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1"

/**
 * The multicast group and port every SSDP participant listens on, fixed by the
 * UPnP spec. It is repeated in the `HOST` header of the search because the
 * receiving device checks that the datagram was addressed to the group, not
 * because anything derives the destination from the text.
 */
export const MULTICAST_HOST = "239.255.255.250:1900"

/** HTTP framing, so every line ends CRLF — a bare LF is not a header break. */
const CRLF = "\r\n"

/**
 * `MX` is the widest random delay, in whole seconds, a device may sit on before
 * replying: they spread their answers across the window so a hundred boxes on
 * one segment do not collide. It has to be an integer, and the spec caps it at
 * 5 — a larger value is a device's licence to make the caller wait, and some
 * firmware treats a malformed one as a reason to ignore the search entirely.
 */
const boundedMx = (seconds: number): number => Math.min(5, Math.max(1, Math.round(seconds)))

/**
 * The M-SEARCH datagram body, as text ready to send.
 *
 * `seconds` defaults to 2, which is the practical floor: shorter than the time
 * a device may take to answer means the socket is closed before the slower half
 * of the network has replied.
 */
export const searchFor = (target: string, seconds = 2): string =>
  [
    "M-SEARCH * HTTP/1.1",
    `HOST: ${MULTICAST_HOST}`,
    // The quotation marks around ssdp:discover are part of the token the spec
    // defines, not punctuation in this file. Devices do a literal comparison
    // against `"ssdp:discover"` and silently drop the search without them.
    `MAN: "ssdp:discover"`,
    `MX: ${boundedMx(seconds)}`,
    `ST: ${target}`,
    // A trailing empty field, then the join, is what produces the blank line
    // that terminates the header block. Without it some devices wait for the
    // rest of a message that is already complete.
    "",
    ""
  ].join(CRLF)

/** A renderer that answered a search. */
export interface Found {
  /** Where its description XML lives; the only thing worth having. */
  readonly location: string
  /** Unique Service Name: stable per device, so it is the deduplication key. */
  readonly usn: string
  /** Free-form product string, useful only in logs. */
  readonly server: Option.Option<string>
  /** Which search target it is answering, echoed back from our `ST`. */
  readonly searchTarget: Option.Option<string>
}

/**
 * Only a `200` counts. Unsolicited advertisements arrive on the same socket and
 * start `NOTIFY * HTTP/1.1`, including `ssdp:byebye`, which announces a device
 * leaving and carries a `LOCATION` that no longer resolves. Gating on the
 * status line rather than on the headers is what keeps a departure from being
 * read as an arrival.
 */
const isOkStatus = (line: string): boolean => /^HTTP\/1\.[01][ \t]+200\b/i.test(line)

const rowsOf = (packet: string): ReadonlyArray<string> =>
  // Leading whitespace has been seen ahead of the status line; the parse should
  // not turn on it.
  packet.trimStart().split(/\r?\n/)

/**
 * One header line as a lowercased name and its value, or nothing when the line
 * has no colon.
 *
 * `toLowerCase` and not `toLocaleLowerCase`: the latter maps `I` to a dotless
 * `ı` under a Turkish locale, so `LOCATION` would stop matching on the machines
 * where that is the system locale, and only on those.
 */
const asPair = (line: string): ReadonlyArray<readonly [string, string]> => {
  const colon = line.indexOf(":")
  return colon <= 0
    ? []
    : [[line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as const]
}

/**
 * The header block, keyed in lower case because the case on the wire is not
 * agreed: the same field arrives as `LOCATION`, `Location` and `location` from
 * three vendors, and the spec says it is case-insensitive.
 *
 * A later occurrence wins, which is what `Map` does and what a proxy would do.
 */
const headersOf = (rows: ReadonlyArray<string>): ReadonlyMap<string, string> =>
  new Map(
    Array.flatMap(
      // Stop at the blank line. Replies have no body, but a device that pads
      // its datagram then cannot smuggle a second `LOCATION` past the end of
      // the message.
      Array.takeWhile(rows.slice(1), (line) => line.trim().length > 0),
      asPair
    )
  )

/**
 * Read a renderer out of an SSDP reply. Absent when it is not one, or malformed.
 *
 * `LOCATION` and `USN` are both required, and an empty value counts as missing.
 * Without a `LOCATION` there is nothing to fetch and the device is unreachable
 * in practice; without a `USN` there is no key to deduplicate on, and a device
 * repeats every announcement several times by design, so admitting one would
 * mean showing the same television three times in a list.
 */
export const parseResponse = (packet: string): Option.Option<Found> => {
  const rows = rowsOf(packet)
  const headers = headersOf(rows)
  const header = (name: string): Option.Option<string> =>
    Option.filter(Option.fromNullishOr(headers.get(name)), (value) => value.length > 0)
  return Option.flatMap(Option.filter(Array.head(rows), isOkStatus), () =>
    Option.map(
      Option.all({ location: header("location"), usn: header("usn") }),
      ({ location, usn }): Found => ({
        location,
        usn,
        server: header("server"),
        searchTarget: header("st")
      })
    ))
}
