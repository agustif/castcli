// A UPnP/DLNA MediaRenderer, emulated well enough to test against.
//
// The sibling of `Device`, one protocol over. Where a Cast receiver speaks
// length-prefixed protobuf over TLS, a television speaks HTTP: SSDP datagrams
// to be found, a description document to say what it can do, and SOAP posted at
// a control URL to be told what to play. Nothing else is different — in
// particular the half that matters is the same half:
//
//   1. it *serves* the control surface — the description, AVTransport and
//      RenderingControl — answering the actions a control point sends;
//   2. it *pulls* the media over HTTP, exactly as a television does, because
//      `SetAVTransportURI` hands the set a URL and the set fetches it.
//
// That second half is the whole point. Casting is inverted: nothing is ever
// pushed to the device, so a test that checks only the SOAP we sent has checked
// the easy half and proved nothing about whether the film is reachable from
// where the television is standing. Here the emulated set really does issue the
// GET, and a test can assert on what it asked for.
//
// A device, not a service: it owns its own listener, is given a port by the
// operating system, and several can run at once — which is what a living room
// with a television and a soundbar in it looks like.

import { Array, Effect, Option, Queue, Ref, Schema, Scope, Stream } from "effect"
import { Brands } from "@castcli/domain"
import { Actions, Soap, Ssdp } from "@castcli/dlna"
import { HttpClient } from "effect/unstable/http"
import { XMLParser, XMLValidator } from "fast-xml-parser"
import * as dgram from "node:dgram"
import * as http from "node:http"

/** What AVTransport calls the three states a control point ever sees. */
export type TransportState = "PLAYING" | "PAUSED_PLAYBACK" | "STOPPED"

export interface DlnaDevice {
  readonly port: Brands.Port
  readonly descriptionUrl: string
  /** What SetAVTransportURI was given, once it has been. */
  readonly loaded: Effect.Effect<Option.Option<{ uri: string; metadata: string }>>
  /** Every URL this device pulled, in order — the half that matters. */
  readonly fetched: Effect.Effect<ReadonlyArray<string>>
  readonly transportState: Effect.Effect<TransportState>
  readonly volume: Effect.Effect<number>
  readonly seekedTo: Effect.Effect<Option.Option<string>>
}

/**
 * Where the two services are driven from. These are the paths the description
 * points at, and the only ones a control point should ever have learnt: they
 * are not part of any specification, and a controller that hard-codes them
 * works against this device and against nothing else.
 */
const CONTROL_PATH = {
  avTransport: "/AVTransport/control",
  renderingControl: "/RenderingControl/control"
} as const

const DESCRIPTION_PATH = "/description.xml"

/**
 * The product string a real device puts in `SERVER`, in the shape the spec
 * asks for: OS/version, then UPnP/version, then product/version. Nothing reads
 * it except logs and vendor workarounds, but a device that omits it is unusual
 * enough that some control points log a warning about it.
 */
const SERVER = "castcli/1.0 UPnP/1.0 EmulatedRenderer/1.0"

/**
 * XML-escape a value on its way into a document we assemble as text.
 *
 * The same reasoning as `Soap`'s own escape, which is not exported and should
 * not be: a friendly name containing `&` is ordinary — "Bill & Ben's TV" — and
 * interpolated raw it makes the description unparseable, which a control point
 * reports as a device that answered discovery and then vanished.
 */
const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;")

/**
 * `H:MM:SS`, which is how AVTransport writes a position.
 *
 * Deliberately duplicated from the controller's own formatter rather than
 * shared. The two sides of a wire format that agree because they call the same
 * function agree by construction, and a test between them then proves only that
 * the function is deterministic. Written twice, they only agree if the format
 * is right — and the hours field is unpadded, which is the detail worth being
 * caught on.
 */
const asDuration = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60) % 60
  const remaining = whole % 60
  return `${Math.floor(whole / 3600)}:${String(minutes).padStart(2, "0")}:${
    String(remaining).padStart(2, "0")
  }`
}

/** `0:12:34` back to seconds, for the target of a seek. */
const fromDuration = (value: string): Option.Option<number> => {
  const parts = value.split(":").map((part) => Number(part))
  return parts.length !== 3 || parts.some((part) => Number.isNaN(part))
    ? Option.none()
    : Option.some((parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0))
}

// ------------------------------------------------------------------- SOAP in

/**
 * The reading half of `Soap`, in the direction the controller never needs.
 *
 * `Soap.parseResponse` looks for `<ActionResponse>` because a control point
 * only ever reads answers; a device reads the requests, where the element is
 * `<Action>` and its children are the input arguments. The parser is configured
 * identically, for the reasons written out there: prefixes stripped because the
 * one on the wire is whatever the sender chose, and tag values left as text
 * because an `InstanceID` of `0` and a volume of `07` are strings on the wire
 * and stay strings here.
 */
const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreAttributes: true,
  trimValues: true
})

/**
 * Validated first, because `parse` throws on malformed input and a control
 * point that closes the connection mid-post produces exactly that. A body that
 * is not XML is answered with a fault like any other request the device cannot
 * carry out, rather than becoming a defect that kills the listener.
 */
const parseDocument = (xml: string): Option.Option<unknown> =>
  XMLValidator.validate(xml) === true ? Option.some(parser.parse(xml)) : Option.none()

const RequestDocument = Schema.Struct({
  Envelope: Schema.Struct({
    Body: Schema.Record(Schema.String, Schema.Unknown)
  })
})

const decodeRequest = Schema.decodeUnknownOption(RequestDocument)

/**
 * Input arguments as the parser hands them over. The bare-string member covers
 * an action with no arguments at all, which parses as an element with no
 * children and so as the empty string.
 *
 * An argument whose value is itself an element — which is what unescaped
 * DIDL-Lite metadata produces — fails this decode, and the device answers a
 * fault. That is not strictness for its own sake: it is precisely what real
 * televisions do to a controller that forgot to escape its metadata, and a
 * control point should meet that here rather than in a living room.
 */
const Arguments = Schema.Union([Schema.Record(Schema.String, Schema.String), Schema.String])

const decodeArguments = Schema.decodeUnknownOption(Arguments)

/** One action as a device receives it. */
interface Invocation {
  readonly action: string
  readonly args: Record<string, string>
}

const parseInvocation = (xml: string): Option.Option<Invocation> =>
  Option.flatMap(parseDocument(xml), (document) =>
    Option.flatMap(decodeRequest(document), (soap) =>
      // The body of a UPnP request holds exactly one element and it is named
      // after the action, so the first entry is the invocation.
      Option.flatMap(
        Array.head(Object.entries(soap.Envelope.Body)),
        ([action, element]) =>
          Option.map(decodeArguments(element), (args): Invocation => ({
            action,
            args: typeof args === "string" ? {} : args
          }))
      )))

// ------------------------------------------------------------------ SOAP out

/** A successful answer, built by the same code a controller's request is. */
const responseEnvelope = (
  service: string,
  action: string,
  outputs: ReadonlyArray<readonly [string, string]>
): string =>
  Soap.envelope({
    service,
    // The `Response` suffix is not decoration: a control point that pipelines
    // requests on one connection matches the element name to know which of its
    // actions was answered, and an envelope naming the bare action reads as
    // somebody else's reply.
    name: `${action}Response`,
    args: outputs
  })

/**
 * How a device says no.
 *
 * HTTP 500 carrying `s:Fault`, with the part worth reading two levels down in
 * `detail/UPnPError`. 401 "Invalid Action" is the code for an action the
 * service does not implement, and it is worth emulating exactly because it is
 * the one a control point is most likely to meet: every optional action in
 * AVTransport — `Next`, `Previous`, `SetPlayMode`, half of RenderingControl —
 * answers this on most televisions, and a controller that reads a fault as a
 * transport failure will report the set as broken instead of as limited.
 */
const faultEnvelope = (code: string, description: string): string =>
  `<?xml version="1.0"?>` +
  `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
  `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
  `<s:Body>` +
  `<s:Fault>` +
  // Both of these are fixed by the UPnP spec and carry no information; the
  // code below them is the whole message.
  `<faultcode>s:Client</faultcode>` +
  `<faultstring>UPnPError</faultstring>` +
  `<detail>` +
  `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0">` +
  `<errorCode>${escape(code)}</errorCode>` +
  `<errorDescription>${escape(description)}</errorDescription>` +
  `</UPnPError>` +
  `</detail>` +
  `</s:Fault>` +
  `</s:Body>` +
  `</s:Envelope>`

const INVALID_ACTION = faultEnvelope("401", "Invalid Action")

// --------------------------------------------------------------- description

/**
 * The device description, with **relative** control URLs.
 *
 * This is the thing that catches control points out, and it is not an edge
 * case: the UPnP spec writes URLs in the description relative to the URL the
 * description was fetched from, and real devices do it — `AVTransport/control`
 * with no leading slash, resolving against `http://host:port/description.xml`.
 * A controller that posts to the string as it appears in the document is
 * posting to a path with no host, and the failure looks like a television
 * ignoring commands rather than like a mistake of its own. Writing them
 * relative here is what makes that bug show up in a test.
 *
 * The two services are what a renderer is: AVTransport carries
 * `SetAVTransportURI`, `Play` and `Seek`, RenderingControl carries volume. A
 * device without the first is not a renderer at all — a NAS advertising only
 * ContentDirectory answers discovery identically — and one without the second
 * is an ordinary television with a fixed output level.
 */
const descriptionXml = (friendlyName: string, udn: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<root xmlns="urn:schemas-upnp-org:device-1-0">` +
  `<specVersion><major>1</major><minor>0</minor></specVersion>` +
  `<device>` +
  `<deviceType>${Ssdp.MEDIA_RENDERER}</deviceType>` +
  `<friendlyName>${escape(friendlyName)}</friendlyName>` +
  `<manufacturer>castcli</manufacturer>` +
  `<modelName>Emulated MediaRenderer</modelName>` +
  `<UDN>${escape(udn)}</UDN>` +
  `<serviceList>` +
  `<service>` +
  `<serviceType>${Actions.AVTransport}</serviceType>` +
  `<serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>` +
  `<SCPDURL>AVTransport/scpd.xml</SCPDURL>` +
  `<controlURL>AVTransport/control</controlURL>` +
  `<eventSubURL>AVTransport/event</eventSubURL>` +
  `</service>` +
  `<service>` +
  `<serviceType>${Actions.RenderingControl}</serviceType>` +
  `<serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>` +
  `<SCPDURL>RenderingControl/scpd.xml</SCPDURL>` +
  `<controlURL>RenderingControl/control</controlURL>` +
  `<eventSubURL>RenderingControl/event</eventSubURL>` +
  `</service>` +
  `</serviceList>` +
  `</device>` +
  `</root>`

/**
 * The unique device name, which has to survive a restart of the control point
 * and be different for every device on the segment.
 *
 * Shaped like a UUID because control points validate that it is one — the port
 * is what makes it unique, since two emulated sets on one machine cannot share
 * a port. A random one would be more realistic and would make every test run
 * announce a device that had never been seen before, which is precisely the
 * behaviour that fills a control point's cache with ghosts.
 */
const udnFor = (port: number): string =>
  `uuid:00000000-0000-1000-8000-${String(port).padStart(12, "0")}`

// ---------------------------------------------------------------------- SSDP

const SSDP_ADDRESS = "239.255.255.250"
const SSDP_PORT = 1900

/** HTTP framing: every line ends CRLF, and a bare LF is not a header break. */
const CRLF = "\r\n"

/**
 * The header block of a datagram, keyed in lower case.
 *
 * `Ssdp` parses replies, because a control point only ever reads those. This
 * reads a *search*, which is a request and not a response, so it lives with the
 * thing that answers them. The lower-casing is for the same reason as there:
 * the field arrives as `ST`, `St` and `st` from three different control points
 * and the spec says the name is case-insensitive.
 */
const headersOf = (packet: string): ReadonlyMap<string, string> =>
  new Map(
    Array.flatMap(packet.trimStart().split(/\r?\n/).slice(1), (line) => {
      const colon = line.indexOf(":")
      return colon <= 0
        ? []
        : [[line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as const]
    })
  )

const isSearch = (packet: string): boolean =>
  /^M-SEARCH[ \t]+\*[ \t]+HTTP\/1\.[01]/i.test(packet.trimStart())

/**
 * The search target to answer a datagram with, or None to stay silent.
 *
 * Three targets are answered and they are not interchangeable. `ssdp:all` is a
 * sweep, and a device answers it with what it actually is. `upnp:rootdevice`
 * is what several control points search for *instead of* the device type,
 * fetching every description and reading the type out of the XML — a device
 * that answers only its own type is invisible to those, which is a bug that
 * reads as "it works in one app and not the other". The device type itself is
 * the targeted search.
 *
 * `MAN` and `MX` are both required, and a datagram without them is dropped
 * rather than answered. That is real behaviour worth reproducing: firmware
 * compares `MAN` literally against `"ssdp:discover"`, quotation marks included,
 * and a control point that omits them gets silence from a room full of
 * televisions with no indication of why.
 */
export const searchTargetOf = (packet: string): Option.Option<string> => {
  const headers = headersOf(packet)
  const header = (name: string): Option.Option<string> =>
    Option.filter(Option.fromNullishOr(headers.get(name)), (value) => value.length > 0)

  return Option.flatMap(
    Option.filter(
      Option.all({ man: header("man"), mx: header("mx"), st: header("st") }),
      ({ man, mx }) =>
        isSearch(packet) &&
        man.replaceAll("\"", "") === "ssdp:discover" &&
        Number.isInteger(Number(mx))
    ),
    ({ st }) =>
      st === "ssdp:all"
        ? Option.some(Ssdp.MEDIA_RENDERER)
        : st === "upnp:rootdevice" || st === Ssdp.MEDIA_RENDERER
        ? Option.some(st)
        : Option.none()
  )
}

/**
 * The unicast reply to a search, as text ready to send.
 *
 * `LOCATION` is the only load-bearing field: everything a control point can do
 * with the device is described at the far end of it, and the datagram itself
 * says almost nothing. `EXT` is the odd one — it is mandatory, it is always
 * empty, and it exists only to assert that the sender understood the `MAN`
 * header it was sent. Devices that omit it are rejected by strict controllers.
 *
 * `USN` is the device's identity joined to the target being answered, which is
 * how a control point deduplicates the same set answering three searches.
 */
export const searchResponsePacket = (
  target: string,
  location: string,
  udn: string
): string =>
  [
    "HTTP/1.1 200 OK",
    // Half an hour, which is what the spec's examples use. It is how long a
    // control point may believe in the device without hearing from it again.
    "CACHE-CONTROL: max-age=1800",
    "EXT:",
    `LOCATION: ${location}`,
    `SERVER: ${SERVER}`,
    `ST: ${target}`,
    `USN: ${udn}::${target}`,
    // The trailing empty field, then the join, is what terminates the header
    // block. Without it some control points wait for the rest of a message
    // that is already complete.
    "",
    ""
  ].join(CRLF)

/**
 * Answer searches for as long as the scope is open.
 *
 * Replies go back to the querier directly rather than to the group, which is
 * what the spec requires of a search response and what keeps an emulated
 * television from announcing itself to a whole network. Nothing is sent
 * unsolicited: a real device multicasts `NOTIFY ssdp:alive` when it powers on,
 * and doing that here would put a set in the device list of every phone on the
 * LAN without anybody asking.
 *
 * The reply is immediate, where a real device waits a random interval of up to
 * `MX` seconds before answering so that a hundred televisions do not collide.
 * That makes this the *easy* case: a control point that closes its socket early
 * still finds this device, and then finds nothing in a real living room.
 */
const answerSearches = (
  location: string,
  udn: string
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*() {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true })
    const searches = yield* Queue.unbounded<{ packet: string; from: dgram.RemoteInfo }>()

    // The datagram callback cannot run an Effect, so it hands the text to a
    // queue and a forked fiber does the work — the same boundary `Discovery`
    // and `Advertise` draw, and the reason none of them reaches for the runtime
    // from inside library code.
    socket.on("message", (packet: Buffer, from: dgram.RemoteInfo) => {
      Queue.offerUnsafe(searches, { packet: packet.toString("utf8"), from })
    })
    socket.on("error", () => undefined)

    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        // `reuseAddr` because 1900 is a fixed port that anything else speaking
        // SSDP on this machine — a media server, another emulated device — is
        // also bound to.
        socket.bind(SSDP_PORT, () => resume(Effect.void))
      }),
      () => Effect.sync(() => socket.close())
    )

    // Joining the group is what makes multicast searches arrive at all, and a
    // machine with no multicast-capable interface refuses it. Unicast searches
    // still reach a control point on the same host, which is the case a test
    // cares about, so this is reported and carried on from rather than fatal.
    yield* Effect.try({
      try: () => socket.addMembership(SSDP_ADDRESS),
      catch: (cause) => cause
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug(`could not join the SSDP group; answering unicast only: ${cause}`)
      )
    )

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(searches), ({ from, packet }) =>
        Option.match(searchTargetOf(packet), {
          onNone: () => Effect.void,
          onSome: (target) =>
            Effect.sync(() => {
              const reply = Buffer.from(searchResponsePacket(target, location, udn), "utf8")
              socket.send(reply, from.port, from.address, () => {})
            })
        }))
    )
  })

// -------------------------------------------------------------------- device

/**
 * The whole request body, once it has all arrived.
 *
 * The socket callbacks cannot run an Effect, so the bytes accumulate in a local
 * array that nothing else can see and become a value at `end`. A truncated post
 * is an ordinary thing to receive — a control point that gave up mid-send
 * produces one — so what did arrive is answered on its merits rather than
 * becoming a failure of the listener.
 */
const bodyOf = (request: http.IncomingMessage): Effect.Effect<string> =>
  Effect.callback<string>((resume) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))))
    request.on("error", () => resume(Effect.succeed("")))
  })

/** What the device answered, ready to be written to the socket. */
interface Answer {
  readonly status: number
  readonly body: string
}

const NOT_FOUND: Answer = { status: 404, body: "" }

/**
 * Start an emulated renderer.
 *
 * Scoped: the listener closes with the scope, so a test that fails still frees
 * its port.
 */
export const make = (options: {
  readonly friendlyName?: string
  /**
   * Announce over SSDP so a control point can *find* this device rather than
   * being told where it is.
   *
   * Off by default, and deliberately so — the same reasoning as the Cast
   * device's mDNS advertisement. Announcing a television on a real network is
   * not a private act: every phone, laptop and set-top box on the segment will
   * list it and offer to play to something that is not a television. Tests opt
   * in; nothing else does. Even opted in, the address handed out is loopback,
   * so the only control point that can reach it is one on this machine.
   */
  readonly advertise?: boolean
} = {}): Effect.Effect<DlnaDevice, never, Scope.Scope | HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const friendlyName = options.friendlyName ?? "Emulated Renderer"

    const loaded = yield* Ref.make(Option.none<{ uri: string; metadata: string }>())
    const fetched = yield* Ref.make<ReadonlyArray<string>>([])
    const transport = yield* Ref.make<TransportState>("STOPPED")
    // A television has a volume before anybody sets one, and UPnP counts it in
    // whole percent where Cast counts 0..1 — which is why the controller
    // multiplies by a hundred on its way here.
    const volume = yield* Ref.make(50)
    const seeked = yield* Ref.make(Option.none<string>())
    const position = yield* Ref.make(0)

    const client = yield* HttpClient.HttpClient

    /**
     * The pull. A real renderer fetches the URL it was given the moment it is
     * told to play, and everything about whether a film reaches a television
     * depends on this working from where the television is standing rather than
     * from where the controller is.
     *
     * `getcontentFeatures.dlna.org` is sent because every DLNA renderer sends
     * it: the server answers with `contentFeatures.dlna.org`, and a media
     * server that ignores the header is one whose files play on some sets and
     * not others.
     */
    const pull = (url: string) =>
      Effect.gen(function*() {
        const response = yield* client.get(url, {
          headers: { "getcontentFeatures.dlna.org": "1" }
        })
        // Drained, not read: the body is a film, and its content is nothing
        // this device has any use for. Draining it is still the honest thing —
        // a renderer that opened a connection and never read it would leave the
        // server holding a stalled write.
        yield* response.arrayBuffer
        yield* Ref.update(fetched, (all) => [...all, url])
      })

    /**
     * Playback is asked for on the control channel and happens somewhere else.
     * A real set answers `Play` at once and fetches in its own time; holding
     * the SOAP response open while megabytes transfer would be a lie, and a
     * control point that timed out waiting for it would look like the failing
     * party. So the URL is handed to a fiber that is already running — the same
     * boundary the datagram callbacks draw, and it keeps the pulls in the order
     * they were asked for.
     */
    const pulls = yield* Queue.unbounded<string>()

    yield* Effect.forkScoped(
      Stream.runForEach(
        Stream.fromQueue(pulls),
        (url) => pull(url).pipe(Effect.orElseSucceed(() => undefined))
      )
    )

    const outputsFor = (
      service: string,
      invocation: Invocation
    ): Option.Option<Effect.Effect<ReadonlyArray<readonly [string, string]>>> => {
      const argument = (name: string): Option.Option<string> =>
        Option.fromNullishOr(invocation.args[name])

      // Keyed by service and action together, because the control URL is what
      // routes a request on a real device: `GetVolume` posted at AVTransport is
      // not a volume enquiry, it is an action that service does not have, and
      // answering it anyway would let a controller with the two URLs swapped
      // pass against this device and fail against every real one.
      const handlers: Record<
        string,
        Effect.Effect<ReadonlyArray<readonly [string, string]>>
      > = {
        [`${Actions.AVTransport}#SetAVTransportURI`]: Effect.gen(function*() {
          yield* Ref.set(
            loaded,
            Option.some({
              uri: Option.getOrElse(argument("CurrentURI"), () => ""),
              // The metadata is not decoration to a television: it carries the
              // title, the duration and the protocol info, and a set handed a
              // bare URL commonly plays it with no seek bar and the URL as its
              // title. Recording it is how a test can say the controller sent
              // one at all.
              metadata: Option.getOrElse(argument("CurrentURIMetaData"), () => "")
            })
          )
          // Setting the URI does not start playback, and a device that started
          // anyway would hide a controller that forgot to send `Play`.
          yield* Ref.set(transport, "STOPPED")
          yield* Ref.set(position, 0)
          return []
        }),

        [`${Actions.AVTransport}#Play`]: Effect.gen(function*() {
          yield* Ref.set(transport, "PLAYING")
          const media = yield* Ref.get(loaded)
          // A `Play` with no URI set is a transition a real device refuses with
          // error 701; this one simply has nothing to fetch, which is the same
          // observable outcome without inventing a second fault path.
          yield* Option.match(media, {
            onNone: () => Effect.void,
            onSome: (info) => Queue.offer(pulls, info.uri)
          })
          return []
        }),

        [`${Actions.AVTransport}#Pause`]: Effect.as(Ref.set(transport, "PAUSED_PLAYBACK"), []),

        [`${Actions.AVTransport}#Stop`]: Effect.gen(function*() {
          yield* Ref.set(transport, "STOPPED")
          yield* Ref.set(position, 0)
          return []
        }),

        [`${Actions.AVTransport}#Seek`]: Effect.gen(function*() {
          const target = Option.getOrElse(argument("Target"), () => "")
          yield* Ref.set(seeked, Option.some(target))
          // `REL_TIME` is relative to the start of the track and is the unit
          // every set implements; `ABS_TIME` is meaningful only for broadcast
          // media. A target that is not a duration moves nothing rather than
          // moving to zero, which is what a mistyped seek should do.
          yield* Option.match(fromDuration(target), {
            onNone: () => Effect.void,
            onSome: (seconds) => Ref.set(position, seconds)
          })
          return []
        }),

        [`${Actions.AVTransport}#GetTransportInfo`]: Effect.map(
          Ref.get(transport),
          (state): ReadonlyArray<readonly [string, string]> => [
            ["CurrentTransportState", state],
            // `OK` is the status of the *transport*, not of the playback: a set
            // reports `ERROR_OCCURRED` here when it could not fetch the media,
            // which is the one place a pull failure becomes visible to a
            // controller that only asks how things are going.
            ["CurrentTransportStatus", "OK"],
            ["CurrentSpeed", "1"]
          ]
        ),

        [`${Actions.AVTransport}#GetPositionInfo`]: Effect.gen(function*() {
          const media = yield* Ref.get(loaded)
          const at = yield* Ref.get(position)
          const uri = Option.getOrElse(Option.map(media, (info) => info.uri), () => "")
          const metadata = Option.getOrElse(
            Option.map(media, (info) => info.metadata),
            () => "NOT_IMPLEMENTED"
          )
          return [
            ["Track", "1"],
            // A live stream reports `0:00:00` here and it is not an error; a
            // controller that divides by the duration to draw a progress bar
            // has to survive it.
            ["TrackDuration", "0:00:00"],
            ["TrackMetaData", metadata],
            ["TrackURI", uri],
            ["RelTime", asDuration(at)],
            // Most sets answer `NOT_IMPLEMENTED` for the absolute fields, so a
            // controller must read `RelTime` and nothing else.
            ["AbsTime", "NOT_IMPLEMENTED"],
            ["RelCount", "2147483647"],
            ["AbsCount", "2147483647"]
          ] as const
        }),

        [`${Actions.RenderingControl}#SetVolume`]: Effect.gen(function*() {
          const wanted = Option.filter(
            Option.map(argument("DesiredVolume"), (value) => Number(value)),
            Number.isFinite
          )
          yield* Option.match(wanted, {
            onNone: () => Effect.void,
            // Clamped rather than refused, which is what sets do: the service
            // declares an allowed range and silently saturates at its ends.
            onSome: (level) =>
              Ref.set(volume, Math.min(100, Math.max(0, Math.round(level))))
          })
          return []
        }),

        [`${Actions.RenderingControl}#GetVolume`]: Effect.map(
          Ref.get(volume),
          (level): ReadonlyArray<readonly [string, string]> => [
            ["CurrentVolume", String(level)]
          ]
        )
      }

      return Option.fromNullishOr(handlers[`${service}#${invocation.action}`])
    }

    const control = (service: string, body: string): Effect.Effect<Answer> =>
      Option.match(Option.flatMap(parseInvocation(body), (invocation) =>
        Option.map(
          outputsFor(service, invocation),
          (run) => ({ invocation, run })
        )), {
        onNone: () => Effect.succeed({ status: 500, body: INVALID_ACTION }),
        onSome: ({ invocation, run }) =>
          Effect.map(run, (outputs) => ({
            status: 200,
            body: responseEnvelope(service, invocation.action, outputs)
          }))
      })

    const server = http.createServer()
    const requests = yield* Queue.unbounded<{
      request: http.IncomingMessage
      response: http.ServerResponse
    }>()

    server.on("request", (request, response) => {
      Queue.offerUnsafe(requests, { request, response })
    })

    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        // Loopback only. A device bound to every interface is one any machine
        // on the network can drive, which is not what an emulator is for.
        server.listen(0, "127.0.0.1", () => resume(Effect.void))
      }),
      () =>
        Effect.sync(() => {
          // Connections first: `close` alone waits for the keep-alive sockets a
          // control point leaves open, so a test that finished cleanly would
          // hold the process until they timed out.
          server.closeAllConnections()
          server.close()
        })
    )

    const address = server.address()
    const port = Brands.Port.make(
      address !== null && typeof address === "object" ? address.port : 8060
    )
    const descriptionUrl = `http://127.0.0.1:${port}${DESCRIPTION_PATH}`
    const description = descriptionXml(friendlyName, udnFor(port))

    const answer = (request: http.IncomingMessage): Effect.Effect<Answer> =>
      Effect.gen(function*() {
        // Parsed rather than compared: a control point is entitled to send
        // `/AVTransport/control?instance=0`, and a device that matched the
        // whole target would answer 404 to a request that is perfectly valid.
        const path = new URL(request.url ?? "/", descriptionUrl).pathname
        const body = yield* bodyOf(request)

        return yield* path === DESCRIPTION_PATH
          ? Effect.succeed({ status: 200, body: description })
          : path === CONTROL_PATH.avTransport
          ? control(Actions.AVTransport, body)
          : path === CONTROL_PATH.renderingControl
          ? control(Actions.RenderingControl, body)
          : Effect.succeed(NOT_FOUND)
      })

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(requests), ({ request, response }) =>
        Effect.flatMap(answer(request), (written) =>
          Effect.sync(() => {
            // The charset is quoted, which is how the UPnP spec writes it and
            // what several devices insist on receiving; sending it unquoted is
            // answered with 500 by some of them, so the emulator writes the
            // form a controller should expect to be handed back.
            response.writeHead(written.status, {
              "content-type": "text/xml; charset=\"utf-8\""
            })
            response.end(written.body)
          })))
    )

    // Started after the listener, so a control point that finds the device and
    // fetches its description immediately meets something already serving.
    yield* Effect.when(
      answerSearches(descriptionUrl, udnFor(port)),
      Effect.succeed(options.advertise === true)
    )

    return {
      port,
      descriptionUrl,
      loaded: Ref.get(loaded),
      fetched: Ref.get(fetched),
      transportState: Ref.get(transport),
      volume: Ref.get(volume),
      seekedTo: Ref.get(seeked)
    } satisfies DlnaDevice
  })
