// UPnP control messages: SOAP over HTTP, minus the HTTP.
//
// A DLNA renderer is driven by POSTing a SOAP envelope at a service's control
// URL with a `SOAPAction` header naming the action. Everything here is the pure
// half of that exchange — the text that goes out, and the meaning of the text
// that comes back — so it can be exercised against XML captured from real
// televisions instead of against a device that is only in the room sometimes.
//
// Building the request by concatenation is deliberate: the envelope is a fixed,
// tiny shape with no recursion in it. Reading the reply is the opposite problem
// — vendors vary in every way the XML spec permits them to — so that direction
// goes through fast-xml-parser rather than a regular expression that works
// until it meets a device from a different manufacturer.

import { Option, Schema } from "effect"
import { XMLParser, XMLValidator } from "fast-xml-parser"

/** One invocation of one action on one service. */
export interface Action {
  /** e.g. `urn:schemas-upnp-org:service:AVTransport:1` */
  readonly service: string
  /** e.g. `SetAVTransportURI` */
  readonly name: string
  /**
   * Argument name/value pairs, in the order the service declares them.
   *
   * The order is not decoration. UPnP argument lists are positional in
   * practice: renderers that read the envelope with a streaming parser take
   * arguments as they arrive, so `InstanceID` after `CurrentURI` is answered
   * with a fault by devices that accept the same arguments the other way round.
   */
  readonly args: ReadonlyArray<readonly [name: string, value: string]>
}

/** SOAP 1.1's envelope namespace, which UPnP fixes; nothing else is accepted. */
const ENVELOPE_NS = "http://schemas.xmlsoap.org/soap/envelope/"

/**
 * SOAP section 5 encoding. UPnP does not actually use the section 5 rules, but
 * the device control protocol spec prints this attribute in every example and
 * enough renderers match on the envelope shape that omitting it is not worth
 * the twelve saved bytes.
 */
const ENCODING_STYLE = "http://schemas.xmlsoap.org/soap/encoding/"

/**
 * XML-escape a value on its way into the envelope.
 *
 * This is not defensive tidiness, it is the single thing most likely to break
 * DLNA playback. `SetAVTransportURI` takes the DIDL-Lite metadata document *as
 * a string argument*, so that value is itself XML and arrives full of `<`, `>`
 * and `&`. Interpolated raw it closes the envelope's own elements early, and
 * the device answers 500 with a parse error — or, worse, accepts a document
 * that happens to still be well formed and plays something truncated.
 *
 * Quotes and apostrophes are escaped as well. They only strictly matter inside
 * attributes, but film titles are full of both and a value that is safe
 * everywhere is one less thing to reason about at the call site.
 */
const escape = (value: string): string =>
  value
    // `&` has to go first. Escaping it last would re-escape the ampersands the
    // other replacements just introduced, and the device would receive
    // `&amp;lt;` where the metadata said `<`.
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;")

/**
 * The value of the `SOAPAction` HTTP header, quotes included.
 *
 * The double quotes are part of the header value in SOAP 1.1, not shell
 * punctuation that crept in — a header sent without them is answered with
 * "401 Invalid Action" by renderers that otherwise accept the identical
 * envelope, which reads as an authentication problem and is not one.
 */
export const actionHeader = (action: Action): string => `"${action.service}#${action.name}"`

/**
 * The full SOAP envelope to POST.
 *
 * Argument *names* are interpolated unescaped, because they are element names
 * rather than text: escaping one would produce an invalid name instead of a
 * safe one. They come from the service description the device published, so
 * they are ours or the device's, never a user's.
 */
export const envelope = (action: Action): string =>
  `<?xml version="1.0"?>` +
  `<s:Envelope xmlns:s="${ENVELOPE_NS}" s:encodingStyle="${ENCODING_STYLE}">` +
  `<s:Body>` +
  `<u:${action.name} xmlns:u="${escape(action.service)}">` +
  action.args.map(([name, value]) => `<${name}>${escape(value)}</${name}>`).join("") +
  `</u:${action.name}>` +
  `</s:Body>` +
  `</s:Envelope>`

/**
 * One parser, configured against the two habits of vendor XML that quietly
 * corrupt a naive reading.
 *
 * `removeNSPrefix` because the prefix on the response element is whatever the
 * device felt like: the spec's own examples use `u:`, several Sony and LG
 * renderers send `m:`, and anything that declares the service as the default
 * namespace sends no prefix at all. All three mean the same element, so the
 * only sane thing to match on is the local name, and stripping prefixes at
 * parse time is what makes the local name the key.
 *
 * `parseTagValue: false` because otherwise numeric-looking text comes back as a
 * number, and every one of those conversions is lossy in a way that surfaces
 * far from here: a `CurrentVolume` of `07` becomes `7`, a track or object id of
 * `0123` loses its leading zero and no longer identifies the object, and an id
 * longer than 2^53 is silently rounded to a different id. These are strings on
 * the wire and they stay strings.
 *
 * Attributes are ignored because nothing in a SOAP body is carried in one —
 * only the namespace declarations, which `removeNSPrefix` has already made
 * irrelevant.
 */
const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreAttributes: true,
  // Devices pretty-print their responses, so an untrimmed value carries the
  // newline and indentation that surrounded it.
  trimValues: true
})

/**
 * The parsed document, or None if the input is not XML at all.
 *
 * `XMLParser.parse` throws on malformed input, and a truncated body is an
 * entirely ordinary thing to receive — a television that closes the connection
 * mid-response produces one. `XMLValidator.validate` answers the same question
 * by returning an error object rather than throwing, so the malformed case
 * becomes None like every other absence in this module.
 */
const parseDocument = (xml: string): Option.Option<unknown> =>
  XMLValidator.validate(xml) === true ? Option.some(parser.parse(xml)) : Option.none()

/**
 * Just enough of the document to reach the body. Prefixes are gone by the time
 * a schema sees this, so `Envelope` and `Body` are the local names.
 *
 * The body's children stay `Unknown`: which element is in there is the very
 * question `parseResponse` is asking, and a fault body is a different shape.
 */
const Document = Schema.Struct({
  Envelope: Schema.Struct({
    Body: Schema.Record(Schema.String, Schema.Unknown)
  })
})

const decodeDocument = Schema.decodeUnknownOption(Document)

/**
 * Output arguments as the parser hands them over.
 *
 * The bare-string member is not a fallback for something odd. An action with no
 * output arguments — which is most of the ones a controller sends, `Play`,
 * `Stop` and `SetAVTransportURI` included — comes back as an element with no
 * children, and the parser represents that as the empty string. It has to read
 * as "succeeded, nothing to report" rather than as a failure to parse, so it is
 * a declared member of the union.
 */
const Outputs = Schema.Union([Schema.Record(Schema.String, Schema.String), Schema.String])

const decodeOutputs = Schema.decodeUnknownOption(Outputs)

/**
 * Output arguments of a successful response, by name.
 *
 * None covers cases a caller treats alike: the body was not XML, it was a fault
 * rather than a response, or it answered some other action. That last one is
 * worth keeping distinct from success — a controller that pipelines requests on
 * one connection can be handed the previous action's reply, and reading it as
 * this action's empty output set means reporting a play that never happened.
 */
export const parseResponse = (
  xml: string,
  action: string
): Option.Option<Record<string, string>> =>
  Option.flatMap(parseDocument(xml), (document) =>
    Option.flatMap(decodeDocument(document), (soap) =>
      Option.flatMap(
        // An index lookup is where undefined enters; it is converted to an
        // Option immediately and never travels any further than this line.
        Option.fromNullishOr(soap.Envelope.Body[`${action}Response`]),
        (element) =>
          Option.map(
            decodeOutputs(element),
            (outputs): Record<string, string> => typeof outputs === "string" ? {} : outputs
          )
      )))

/** A UPnP fault, which is how a device says no. */
export interface Fault {
  readonly code: string
  readonly description: string
}

/**
 * The shape of a refusal: HTTP 500 carrying `<s:Fault>`, with the part worth
 * reading buried two levels down in `detail/UPnPError`.
 *
 * The SOAP-level `faultcode` and `faultstring` are always `s:Client` and
 * `UPnPError` and so carry no information. The UPnP error code is what
 * separates "701 transition not available" (told to play while stopped, so the
 * fix is to set the URI first) from "716 resource not found" (the device could
 * not fetch the URL we gave it, which is nearly always our own address being
 * one it cannot route to). A caller that shows only "the TV said no" makes both
 * of those look like the same bug.
 *
 * `errorCode` being a `String` schema also pins the parser configuration: were
 * `parseTagValue` ever turned back on, `701` would arrive as a number and this
 * decode would fail loudly here rather than corrupt an id somewhere quieter.
 */
const FaultDocument = Schema.Struct({
  Envelope: Schema.Struct({
    Body: Schema.Struct({
      Fault: Schema.Struct({
        detail: Schema.Struct({
          UPnPError: Schema.Struct({
            errorCode: Schema.String,
            // Optional because devices genuinely omit it: several renderers
            // send the code alone, and a missing sentence is no reason to
            // discard the code that came with it.
            errorDescription: Schema.optional(Schema.String)
          })
        })
      })
    })
  })
})

const decodeFault = Schema.decodeUnknownOption(FaultDocument)

/**
 * The fault in a response body, or None if the body is not one.
 *
 * A caller reads the body with both this and `parseResponse`, because the HTTP
 * status is not sufficient evidence on its own — devices exist that return a
 * fault body with 200, and others that return 500 for a transport error with no
 * fault in it at all.
 */
export const parseFault = (xml: string): Option.Option<Fault> =>
  Option.flatMap(parseDocument(xml), (document) =>
    Option.map(decodeFault(document), (soap) => {
      const error = soap.Envelope.Body.Fault.detail.UPnPError
      return {
        code: error.errorCode,
        description: Option.getOrElse(Option.fromNullishOr(error.errorDescription), () => "")
      }
    }))
