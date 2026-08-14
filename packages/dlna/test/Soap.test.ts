// SOAP control, against the XML televisions actually send.
//
// Two classes of bug live here and neither is visible by eye. The first is
// escaping: the DIDL-Lite metadata argument is a whole XML document passed as a
// string, so an unescaped `<` produces an envelope that is still well formed
// and means something else entirely. The second is vendor variance in the
// reply — the response element's namespace prefix is `u:`, `m:` or absent
// depending on who made the device, and a parser that matches on the prefix
// works perfectly until it meets the next brand.

import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { XMLParser } from "fast-xml-parser"
import { actionHeader, envelope, parseFault, parseResponse } from "../src/Soap.ts"

const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1"
const RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1"

/**
 * A DIDL-Lite document of the kind `SetAVTransportURI` carries: angle brackets
 * throughout, an ampersand in the title, and an apostrophe for good measure.
 */
const DIDL = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">` +
  `<item id="0" parentID="-1" restricted="1"><dc:title>Fish &amp; Chips ` +
  `(Director's Cut)</dc:title><upnp:class>object.item.videoItem</upnp:class>` +
  `</item></DIDL-Lite>`

/** A reader for the request we produced, to prove the escaping round-trips. */
const requestParser = new XMLParser({ removeNSPrefix: true, parseTagValue: false })

const argumentOf = (xml: string, action: string, name: string): unknown =>
  requestParser.parse(xml)?.["Envelope"]?.["Body"]?.[action]?.[name]

describe("actionHeader", () => {
  it("keeps the double quotes, which are part of the value", () => {
    // Sent bare, the same envelope comes back as "401 Invalid Action", which
    // reads like an authentication failure and is not one.
    assert.strictEqual(
      actionHeader({ service: AV_TRANSPORT, name: "Play", args: [] }),
      `"urn:schemas-upnp-org:service:AVTransport:1#Play"`
    )
  })
})

describe("envelope", () => {
  it("names the action, the service and the SOAP namespaces", () => {
    const xml = envelope({
      service: AV_TRANSPORT,
      name: "Play",
      args: [["InstanceID", "0"], ["Speed", "1"]]
    })

    assert.strictEqual(
      xml,
      `<?xml version="1.0"?>` +
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
        `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
        `<s:Body><u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
        `<InstanceID>0</InstanceID><Speed>1</Speed>` +
        `</u:Play></s:Body></s:Envelope>`
    )
  })

  it("keeps arguments in the order given, because devices read them positionally", () => {
    const xml = envelope({
      service: RENDERING_CONTROL,
      name: "SetVolume",
      args: [["InstanceID", "0"], ["Channel", "Master"], ["DesiredVolume", "7"]]
    })

    assert.isBelow(xml.indexOf("<InstanceID>"), xml.indexOf("<Channel>"))
    assert.isBelow(xml.indexOf("<Channel>"), xml.indexOf("<DesiredVolume>"))
  })

  it("escapes a DIDL-Lite value rather than letting it close the envelope", () => {
    const xml = envelope({
      service: AV_TRANSPORT,
      name: "SetAVTransportURI",
      args: [
        ["InstanceID", "0"],
        ["CurrentURI", "http://192.168.1.5:8080/film.mp4?a=1&b=2"],
        ["CurrentURIMetaData", DIDL]
      ]
    })

    // The metadata's own markup must not appear as markup: a raw `<DIDL-Lite`
    // here would open an element inside our body and everything after it would
    // belong to a document nobody meant to write.
    assert.notInclude(xml, "<DIDL-Lite")
    assert.include(xml, "&lt;DIDL-Lite")
    // `&amp;` in the source metadata has to arrive double-escaped, or the
    // device's parser turns it back into a bare `&` and the title is malformed.
    assert.include(xml, "Fish &amp;amp; Chips")
    assert.include(xml, "film.mp4?a=1&amp;b=2")

    // And the whole thing has to survive a real parser unchanged, which is the
    // property that actually matters: what the television reads back is exactly
    // the metadata document we were given.
    assert.strictEqual(argumentOf(xml, "SetAVTransportURI", "CurrentURIMetaData"), DIDL)
    assert.strictEqual(
      argumentOf(xml, "SetAVTransportURI", "CurrentURI"),
      "http://192.168.1.5:8080/film.mp4?a=1&b=2"
    )
  })
})

describe("parseResponse", () => {
  it("reads a `u:` response with no outputs as an empty success", () => {
    // Sony BDP, and the spec's own example. An action with nothing to report
    // still succeeded, so this is Some({}) and never None.
    const reply = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
      `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:SetAVTransportURIResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
</u:SetAVTransportURIResponse>
</s:Body>
</s:Envelope>`

    assert.deepStrictEqual(parseResponse(reply, "SetAVTransportURI"), Option.some({}))
  })

  it("reads the same response behind an `m:` prefix", () => {
    // LG webOS and several Samsung firmwares prefix with `m:`. Matching on the
    // prefix rather than the local name is what breaks here.
    const reply = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
      `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><m:SetAVTransportURIResponse ` +
      `xmlns:m="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>`

    assert.deepStrictEqual(parseResponse(reply, "SetAVTransportURI"), Option.some({}))
  })

  it("reads a response with no prefix at all", () => {
    // A device that declares the SOAP namespace as the default sends bare
    // element names. Same document, third spelling.
    const reply = `<?xml version="1.0"?>
<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/"><Body>
<PlayResponse xmlns="urn:schemas-upnp-org:service:AVTransport:1"></PlayResponse>
</Body></Envelope>`

    assert.deepStrictEqual(parseResponse(reply, "Play"), Option.some({}))
  })

  it("returns every output of GetPositionInfo, all of them as strings", () => {
    const reply = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
      `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
<Track>07</Track>
<TrackDuration>01:37:12</TrackDuration>
<TrackMetaData>&lt;DIDL-Lite&gt;&lt;item id="042"&gt;&amp;&lt;/item&gt;&lt;/DIDL-Lite&gt;</TrackMetaData>
<TrackURI>http://192.168.1.5:8080/film.mp4</TrackURI>
<RelTime>00:04:05</RelTime>
<AbsTime>00:04:05</AbsTime>
<RelCount>2147483647</RelCount>
<AbsCount>2147483647</AbsCount>
</u:GetPositionInfoResponse>
</s:Body>
</s:Envelope>`

    assert.deepStrictEqual(
      parseResponse(reply, "GetPositionInfo"),
      Option.some({
        // `07` is the one that matters: parsed as a number it becomes 7, and a
        // track id that loses a leading zero no longer names the same track.
        Track: "07",
        TrackDuration: "01:37:12",
        TrackMetaData: `<DIDL-Lite><item id="042">&</item></DIDL-Lite>`,
        TrackURI: "http://192.168.1.5:8080/film.mp4",
        RelTime: "00:04:05",
        AbsTime: "00:04:05",
        // Beyond 2^31 these are the values devices use for "unknown"; they are
        // compared as text and must not be rounded on the way in.
        RelCount: "2147483647",
        AbsCount: "2147483647"
      })
    )
  })

  it("does not answer for a different action", () => {
    // A controller that reuses a connection can be handed the previous reply.
    // Reading it as this action's empty output set reports a play that the
    // device was never asked to perform.
    const reply = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:StopResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>
</s:Body></s:Envelope>`

    assert.isTrue(Option.isNone(parseResponse(reply, "Play")))
  })

  it("does not read a fault as a response", () => {
    const fault = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>
<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
<errorCode>701</errorCode><errorDescription>Transition not available</errorDescription>
</UPnPError></detail></s:Fault></s:Body></s:Envelope>`

    assert.isTrue(Option.isNone(parseResponse(fault, "Play")))
  })

  it("is None for a body that is not XML", () => {
    // A television that closes the connection mid-response leaves a truncated
    // document behind, which the parser throws on rather than reporting.
    assert.isTrue(Option.isNone(parseResponse("<s:Envelope><s:Body>", "Play")))
    assert.isTrue(Option.isNone(parseResponse("502 Bad Gateway", "Play")))
    assert.isTrue(Option.isNone(parseResponse("", "Play")))
  })
})

describe("parseFault", () => {
  it("returns the UPnP code and description, not the SOAP ones", () => {
    // `faultcode` and `faultstring` are always `s:Client` and `UPnPError`; only
    // the code inside `detail` distinguishes one refusal from another.
    const fault = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
      `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><s:Fault>
<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
<errorCode>701</errorCode><errorDescription>Transition not available</errorDescription>
</UPnPError></detail></s:Fault></s:Body></s:Envelope>`

    assert.deepStrictEqual(
      parseFault(fault),
      Option.some({ code: "701", description: "Transition not available" })
    )
  })

  it("keeps the code as text, so 716 does not arrive as a number", () => {
    // 716 is "resource not found by the device", which in practice means the
    // URL we handed it points at an address it cannot route to.
    const fault = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>716</errorCode>
<errorDescription>Resource not found</errorDescription></UPnPError></detail>
</s:Fault></s:Body></s:Envelope>`

    assert.deepStrictEqual(
      parseFault(fault),
      Option.some({ code: "716", description: "Resource not found" })
    )
  })

  it("still reports a fault that omits the description", () => {
    // Several renderers send the code alone. The sentence was never the useful
    // half, so dropping the whole fault over its absence would be worse.
    const fault = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>
<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>402</errorCode>
</UPnPError></detail></s:Fault></s:Body></s:Envelope>`

    assert.deepStrictEqual(parseFault(fault), Option.some({ code: "402", description: "" }))
  })

  it("is None for a successful response and for rubbish", () => {
    const reply = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/>
</s:Body></s:Envelope>`

    assert.isTrue(Option.isNone(parseFault(reply)))
    assert.isTrue(Option.isNone(parseFault("<html><body>404</body></html>")))
    assert.isTrue(Option.isNone(parseFault("not xml")))
  })
})
