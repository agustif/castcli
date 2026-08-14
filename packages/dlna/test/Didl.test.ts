// DIDL-Lite metadata.
//
// Every failure this file pins is silent at the sending end: the renderer
// accepts `SetAVTransportURI`, answers 200, and then shows a black screen, or
// the wrong title, or no seek bar. There is nothing to see from here, so the
// document is read back through a real XML parser rather than trusted.

import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { XMLParser } from "fast-xml-parser"
import { protocolInfo, videoItem } from "../src/Didl.ts"

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => name === "res"
})

/** Walk a parsed document by key, so nothing here has to assert a type. */
const at = (value: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (node, key) => typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined,
    value
  )

/** Something inside the rendered `<item>`, addressed by path. */
const read = (document: string, ...path: ReadonlyArray<string>): unknown =>
  at(parser.parse(document), ["DIDL-Lite", "item", ...path])

const FILM = {
  title: "Arrival",
  url: "http://192.168.1.10:8010/stream.mp4",
  contentType: "video/mp4",
  durationSeconds: Option.none<number>(),
  subtitleUrl: Option.none<string>()
}

describe("videoItem", () => {
  it("declares every namespace it uses", () => {
    // An undeclared prefix makes the document malformed, so a set that parses
    // strictly rejects the whole thing rather than the one element.
    const document = videoItem(FILM)
    assert.include(document, `xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"`)
    assert.include(document, `xmlns:dc="http://purl.org/dc/elements/1.1/"`)
    assert.include(document, `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"`)
    assert.include(document, `xmlns:sec="http://www.sec.co.kr/"`)
  })

  it("classes the item as a video, which is what makes it playable", () => {
    // The renderer routes on upnp:class: without it there is no player to hand
    // the stream to, and the item is widely refused.
    assert.strictEqual(read(videoItem(FILM), "class"), "object.item.videoItem")
  })

  it("carries the title and the URL", () => {
    assert.strictEqual(read(videoItem(FILM), "title"), "Arrival")
    assert.strictEqual(
      read(videoItem(FILM), "res", "0", "#text"),
      "http://192.168.1.10:8010/stream.mp4"
    )
  })

  it("marks the item parentless and unbrowsable, as a pushed item is", () => {
    assert.strictEqual(read(videoItem(FILM), "@_parentID"), "-1")
    assert.strictEqual(read(videoItem(FILM), "@_restricted"), "1")
  })
})

describe("escaping", () => {
  it("survives a title containing & and <, and still re-parses", () => {
    // Film titles with an ampersand are ordinary. Unescaped, the document is
    // malformed from that character onward and the renderer rejects the lot —
    // which reads as the file being unplayable rather than as our bug.
    const title = `Fire & Ice <Director's Cut> "1983"`
    const document = videoItem({ ...FILM, title })
    assert.notInclude(document, "& Ice")
    assert.include(document, "&amp;")
    assert.include(document, "&lt;")
    assert.strictEqual(read(document, "title"), title)
  })

  it("escapes the URL too, since query strings carry ampersands", () => {
    // `?id=7&t=0` is an entirely normal streaming URL and breaks the document
    // in exactly the same way a title does.
    const url = "http://192.168.1.10:8010/stream.mp4?id=7&t=0"
    assert.strictEqual(read(videoItem({ ...FILM, url }), "res", "0", "#text"), url)
  })
})

describe("duration", () => {
  it("formats as H:MM:SS.mmm", () => {
    // One hour, three minutes, five and a quarter seconds.
    const document = videoItem({ ...FILM, durationSeconds: Option.some(3785.25) })
    assert.strictEqual(read(document, "res", "0", "@_duration"), "1:03:05.250")
  })

  it("leaves the hours unpadded and keeps counting past nine", () => {
    const document = videoItem({ ...FILM, durationSeconds: Option.some(36_000) })
    assert.strictEqual(read(document, "res", "0", "@_duration"), "10:00:00.000")
  })

  it("never rolls the milliseconds up to 1000", () => {
    // Rounding the fractional second on its own yields `:59.1000`, which a
    // renderer reads as garbage and then reports no duration at all.
    const document = videoItem({ ...FILM, durationSeconds: Option.some(59.9999) })
    assert.strictEqual(read(document, "res", "0", "@_duration"), "0:01:00.000")
  })

  it("omits the attribute entirely when the duration is unknown", () => {
    // `duration="0:00:00.000"` is not "unknown", it is a claim that the
    // programme is empty, and a renderer that believes it stops at once.
    assert.notInclude(videoItem(FILM), "duration=")
  })
})

describe("protocolInfo", () => {
  it("advertises seeking, which is what draws the seek bar", () => {
    // DLNA.ORG_OP=01 says we answer HTTP Range requests. Without it the set
    // offers no scrub bar at all.
    assert.include(protocolInfo("video/mp4"), "DLNA.ORG_OP=01")
    assert.strictEqual(
      read(videoItem(FILM), "res", "0", "@_protocolInfo"),
      "http-get:*:video/mp4:DLNA.ORG_OP=01;" +
        "DLNA.ORG_FLAGS=01700000000000000000000000000000"
    )
  })

  it("advertises streaming transfer mode in the flags word", () => {
    // Bit 24 of 0x01700000. Without it a set may try to fetch the whole file
    // before starting, which on a two-hour film is minutes of spinner.
    assert.include(protocolInfo("video/x-matroska"), "DLNA.ORG_FLAGS=01700000")
  })

  it("carries whatever content type it is given", () => {
    assert.include(protocolInfo("video/x-matroska"), "http-get:*:video/x-matroska:")
  })
})

describe("subtitles", () => {
  const SUBS = "http://192.168.1.10:8010/subs.srt"
  const SUBTITLED = { ...FILM, subtitleUrl: Option.some(SUBS) }

  it("adds sec:CaptionInfoEx, which is how the set learns subtitles exist", () => {
    const document = videoItem(SUBTITLED)
    assert.include(document, `<sec:CaptionInfoEx sec:type="srt">`)
    assert.strictEqual(read(document, "CaptionInfoEx", "#text"), SUBS)
    assert.strictEqual(read(document, "CaptionInfoEx", "@_type"), "srt")
  })

  it("adds a second res the set can actually fetch them from", () => {
    // CaptionInfoEx announces the track; the res is where it is downloaded.
    // Either one alone leaves the caption menu empty.
    const document = videoItem(SUBTITLED)
    assert.strictEqual(read(document, "res", "length"), 2)
    assert.strictEqual(read(document, "res", "1", "@_protocolInfo"), "http-get:*:text/srt:*")
    assert.strictEqual(read(document, "res", "1", "#text"), SUBS)
  })

  it("emits neither when there is no subtitle track", () => {
    const document = videoItem(FILM)
    assert.notInclude(document, "CaptionInfo")
    assert.strictEqual(read(document, "res", "length"), 1)
  })
})
