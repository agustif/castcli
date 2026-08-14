// SSDP, tested against what devices actually put on the wire.
//
// The replies below are shaped like real captures rather than like the spec's
// examples: mixed-case header names, an `EXT:` with no value at all, vendor
// headers nobody reads, and a `NOTIFY` arriving on the same socket as the
// answers. Each of those has a matching test because each of them is a way a
// tidier parser quietly returns the wrong thing.

import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { MEDIA_RENDERER, parseResponse, searchFor } from "../src/Ssdp.ts"

/** Build a datagram the way the wire does: CRLF endings, blank line at the end. */
const datagram = (lines: ReadonlyArray<string>): string => `${lines.join("\r\n")}\r\n\r\n`

const UUID = "uuid:d1e4a2f0-8b3c-4a1e-9f27-0011223344ff"

/** A Sony receiver answering a MediaRenderer search, headers as it sends them. */
const REPLY = datagram([
  "HTTP/1.1 200 OK",
  "CACHE-CONTROL: max-age=1800",
  "DATE: Fri, 14 Aug 2026 09:12:03 GMT",
  "EXT:",
  "LOCATION: http://192.168.1.42:52323/dmr.xml",
  "SERVER: Linux/4.9 UPnP/1.0 Sony-BDP/2.0",
  `ST: ${MEDIA_RENDERER}`,
  `USN: ${UUID}::${MEDIA_RENDERER}`,
  "BOOTID.UPNP.ORG: 1",
  "CONFIGID.UPNP.ORG: 3"
])

const locationOf = (packet: string): Option.Option<string> =>
  Option.map(parseResponse(packet), (found) => found.location)

describe("searchFor", () => {
  it("is the datagram the spec describes, verbatim", () => {
    assert.strictEqual(
      searchFor(MEDIA_RENDERER),
      "M-SEARCH * HTTP/1.1\r\n" +
        "HOST: 239.255.255.250:1900\r\n" +
        `MAN: "ssdp:discover"\r\n` +
        "MX: 2\r\n" +
        `ST: ${MEDIA_RENDERER}\r\n` +
        "\r\n"
    )
  })

  it("quotes ssdp:discover, which devices compare literally", () => {
    // Unquoted, the search is dropped without a reply and discovery looks like
    // an empty network.
    assert.include(searchFor(MEDIA_RENDERER), `MAN: "ssdp:discover"`)
  })

  it("ends every line with CRLF and never a bare LF", () => {
    const text = searchFor(MEDIA_RENDERER)
    assert.isFalse(/[^\r]\n/.test(text), "a line ended without its carriage return")
    assert.isTrue(text.endsWith("\r\n\r\n"), "the header block was not terminated")
  })

  it("carries the search target it was given", () => {
    assert.include(searchFor("ssdp:all"), "ST: ssdp:all\r\n")
  })

  it("writes MX as a whole number of seconds", () => {
    // A fractional MX is malformed and some firmware ignores the whole search.
    assert.include(searchFor(MEDIA_RENDERER, 3.4), "MX: 3\r\n")
  })

  it("keeps MX inside the range the spec allows", () => {
    assert.include(searchFor(MEDIA_RENDERER, 60), "MX: 5\r\n")
    assert.include(searchFor(MEDIA_RENDERER, 0), "MX: 1\r\n")
  })
})

describe("parseResponse", () => {
  it("reads a renderer out of a real reply", () => {
    assert.deepStrictEqual(
      parseResponse(REPLY),
      Option.some({
        location: "http://192.168.1.42:52323/dmr.xml",
        usn: `${UUID}::${MEDIA_RENDERER}`,
        server: Option.some("Linux/4.9 UPnP/1.0 Sony-BDP/2.0"),
        searchTarget: Option.some(MEDIA_RENDERER)
      })
    )
  })

  it("does not care how the vendor capitalised the headers", () => {
    // Three vendors, three spellings of the same field, one meaning.
    const casings = ["LOCATION", "Location", "location", "LoCaTiOn"].map((name) =>
      datagram([
        "HTTP/1.1 200 OK",
        `${name}: http://192.168.1.42:52323/dmr.xml`,
        `USN: ${UUID}::${MEDIA_RENDERER}`
      ])
    )
    casings.forEach((packet) => {
      assert.deepStrictEqual(
        locationOf(packet),
        Option.some("http://192.168.1.42:52323/dmr.xml"),
        packet
      )
    })
  })

  it("has nothing to offer for a reply with no LOCATION", () => {
    // There is no URL to fetch a description from, so the device cannot be
    // used even though it answered.
    const noLocation = datagram([
      "HTTP/1.1 200 OK",
      "CACHE-CONTROL: max-age=1800",
      "EXT:",
      "SERVER: Linux/3.10 UPnP/1.0 BRAVIA/3.0",
      `ST: ${MEDIA_RENDERER}`,
      `USN: ${UUID}::${MEDIA_RENDERER}`
    ])
    assert.isTrue(Option.isNone(parseResponse(noLocation)))
  })

  it("treats an empty LOCATION as no LOCATION", () => {
    const empty = datagram([
      "HTTP/1.1 200 OK",
      "LOCATION:",
      `USN: ${UUID}::${MEDIA_RENDERER}`
    ])
    assert.isTrue(Option.isNone(parseResponse(empty)))
  })

  it("ignores a NOTIFY, which is an advertisement and not an answer", () => {
    // An alive notice looks like a find — it even has a LOCATION — but it
    // arrives unsolicited on the same socket, so only the status line tells
    // the two apart.
    const alive = datagram([
      "NOTIFY * HTTP/1.1",
      "HOST: 239.255.255.250:1900",
      "CACHE-CONTROL: max-age=1800",
      "LOCATION: http://192.168.1.42:52323/dmr.xml",
      `NT: ${MEDIA_RENDERER}`,
      "NTS: ssdp:alive",
      `USN: ${UUID}::${MEDIA_RENDERER}`
    ])
    assert.isTrue(Option.isNone(parseResponse(alive)))
  })

  it("ignores a byebye, whose LOCATION points at a device that has gone", () => {
    const byebye = datagram([
      "NOTIFY * HTTP/1.1",
      "HOST: 239.255.255.250:1900",
      `NT: ${MEDIA_RENDERER}`,
      "NTS: ssdp:byebye",
      `USN: ${UUID}::${MEDIA_RENDERER}`
    ])
    assert.isTrue(Option.isNone(parseResponse(byebye)))
  })

  it("ignores an error status", () => {
    const notFound = datagram([
      "HTTP/1.1 404 Not Found",
      "LOCATION: http://192.168.1.42:52323/dmr.xml",
      `USN: ${UUID}::${MEDIA_RENDERER}`
    ])
    assert.isTrue(Option.isNone(parseResponse(notFound)))
  })

  it("ignores our own search, which is multicast back to us", () => {
    assert.isTrue(Option.isNone(parseResponse(searchFor(MEDIA_RENDERER))))
  })

  it("ignores an empty datagram", () => {
    assert.isTrue(Option.isNone(parseResponse("")))
  })

  it("requires a USN, because it is the key duplicates are collapsed on", () => {
    // Every device repeats its announcement; without a USN the same television
    // would be listed once per copy.
    const noUsn = datagram([
      "HTTP/1.1 200 OK",
      "LOCATION: http://192.168.1.42:52323/dmr.xml",
      `ST: ${MEDIA_RENDERER}`
    ])
    assert.isTrue(Option.isNone(parseResponse(noUsn)))
  })

  it("reports SERVER and ST as absent rather than blank when the device omits them", () => {
    const bare = datagram([
      "HTTP/1.1 200 OK",
      "LOCATION: http://192.168.1.42:52323/dmr.xml",
      `USN: ${UUID}::${MEDIA_RENDERER}`
    ])
    assert.deepStrictEqual(
      Option.map(parseResponse(bare), (found) => found.server),
      Option.some(Option.none())
    )
    assert.deepStrictEqual(
      Option.map(parseResponse(bare), (found) => found.searchTarget),
      Option.some(Option.none())
    )
  })

  it("keeps a URL containing colons intact", () => {
    // Splitting on every colon rather than the first one loses the port, which
    // is the difference between fetching the description and fetching nothing.
    assert.deepStrictEqual(
      locationOf(REPLY),
      Option.some("http://192.168.1.42:52323/dmr.xml")
    )
  })

  it("tolerates bare LF endings, which some embedded stacks send", () => {
    const lf = [
      "HTTP/1.1 200 OK",
      "LOCATION: http://192.168.1.42:52323/dmr.xml",
      `USN: ${UUID}::${MEDIA_RENDERER}`,
      "",
      ""
    ].join("\n")
    assert.deepStrictEqual(
      locationOf(lf),
      Option.some("http://192.168.1.42:52323/dmr.xml")
    )
  })

  it("stops at the blank line, so trailing bytes cannot add a header", () => {
    const padded = `${REPLY}LOCATION: http://10.0.0.1:80/evil.xml\r\n\r\n`
    assert.deepStrictEqual(
      locationOf(padded),
      Option.some("http://192.168.1.42:52323/dmr.xml")
    )
  })
})
