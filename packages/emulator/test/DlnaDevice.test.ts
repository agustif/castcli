// What a television looks like to a program that wants to play a film on it.
//
// These run against the emulated renderer over real sockets, because the parts
// worth testing are the ones that only exist on a wire: a description whose
// control URLs are relative and have to be resolved before they can be posted
// to, and a device that fetches the film for itself. The second is the one that
// matters — casting is inverted, nothing is ever pushed to the set — so the
// play test stands up a little media server and requires that the device really
// came and asked for the URL.
//
// `it.live` throughout, not `it.effect`: the latter supplies a TestClock whose
// time never advances, and every one of these waits on a socket.

import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option, Queue, Schedule } from "effect"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient, HttpBody, HttpClient } from "effect/unstable/http"
import { Actions, Description, Didl, Soap, Ssdp } from "@castcli/dlna"
import * as http from "node:http"
import * as DlnaDevice from "../src/DlnaDevice.ts"

const TestServices = Layer.mergeAll(
  // The emulated device is an HTTP *client* as well as a server — pulling is
  // what a renderer does.
  FetchHttpClient.layer,
  NodeServices.layer
)

const INSTANCE = "0"

/**
 * POST one action, exactly as the controller does: the envelope built by the
 * same module, the quoted charset, and the `SOAPAction` header with its
 * quotation marks — a device that receives it without them answers 401, which
 * reads as an authentication problem and is not one.
 */
const invoke = (url: string, action: Soap.Action) =>
  Effect.flatMap(
    HttpClient.post(url, {
      headers: {
        "content-type": "text/xml; charset=\"utf-8\"",
        soapaction: Soap.actionHeader(action)
      },
      body: HttpBody.text(Soap.envelope(action), "text/xml")
    }),
    (response) => Effect.map(response.text, (body) => ({ status: response.status, body }))
  )

/** The outputs of a successful action, read the way the controller reads them. */
const outputsOf = (url: string, action: Soap.Action) =>
  Effect.map(invoke(url, action), (answer) =>
    Option.getOrElse(
      Soap.parseResponse(answer.body, action.name),
      (): Record<string, string> => ({})
    ))

/**
 * The control URLs a device is on, assumed rather than discovered.
 *
 * Assumed only here: the description test is the one that proves a control
 * point which reads the document and resolves its relative URLs arrives at
 * exactly these, which is the whole point of serving them relative.
 */
const avTransport = (device: DlnaDevice.DlnaDevice): string =>
  `http://127.0.0.1:${device.port}/AVTransport/control`

const renderingControl = (device: DlnaDevice.DlnaDevice): string =>
  `http://127.0.0.1:${device.port}/RenderingControl/control`

/**
 * A media server, standing in for the one the CLI runs.
 *
 * It answers anything with a few bytes and the DLNA content features header, so
 * the assertion is about *whether the device came for it* rather than about
 * what it got. Every request is offered to a queue, which is what lets a test
 * wait for the pull instead of sleeping and hoping.
 */
const mediaServer = Effect.gen(function*() {
  const hits = yield* Queue.unbounded<string>()
  const server = http.createServer()

  server.on("request", (request, response) => {
    Queue.offerUnsafe(hits, request.url ?? "")
    response.writeHead(200, {
      "content-type": "video/mp4",
      // What a renderer's `getcontentFeatures.dlna.org` request is asking for.
      // `DLNA.ORG_OP=01` advertises byte-range seeking, which is what makes a
      // television draw a seek bar at all.
      "contentFeatures.dlna.org": "DLNA.ORG_OP=01;DLNA.ORG_CI=0"
    })
    response.end("a film, in spirit")
  })

  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void))
    }),
    () =>
      Effect.sync(() => {
        // Connections first: `close` alone waits out the keep-alive socket the
        // renderer left open, and vitest would sit there waiting with it.
        server.closeAllConnections()
        server.close()
      })
  )

  const address = server.address()
  const port = address !== null && typeof address === "object" ? address.port : 0

  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    hits
  }
})

/**
 * Wait for something the device does on its own fibre.
 *
 * The pull happens after the SOAP answer, by design, so there is nothing to
 * await on the response itself. Polling with a real clock is the honest way to
 * observe it; the timeout is generous because a loaded machine is not a bug.
 */
const eventually = <A>(effect: Effect.Effect<A>, holds: (value: A) => boolean) =>
  Effect.timeoutOption(
    Effect.repeat(effect, { schedule: Schedule.spaced(Duration.millis(25)), until: holds }),
    Duration.seconds(5)
  )

const load = (device: DlnaDevice.DlnaDevice, url: string) =>
  invoke(
    avTransport(device),
    Actions.setAVTransportURI({
      InstanceID: INSTANCE,
      CurrentURI: url,
      CurrentURIMetaData: Didl.videoItem({
        title: "Test Pattern",
        url,
        contentType: "video/mp4",
        durationSeconds: Option.some(90),
        subtitleUrl: Option.none()
      })
    })
  )

describe("the description", () => {
  it.live("is served, and names both of the services a renderer is", () =>
    Effect.gen(function*() {
      const device = yield* DlnaDevice.make({ friendlyName: "Emulated Plasma" })
      const xml = yield* Effect.flatMap(HttpClient.get(device.descriptionUrl), (r) => r.text)

      // Written relative, as a real device writes them. This is not decoration:
      // a control point that posts to the string as it appears here is posting
      // to a path with no host, and the failure looks like a television
      // ignoring commands.
      assert.include(xml, "<controlURL>AVTransport/control</controlURL>")
      assert.notInclude(xml, "<controlURL>http://")

      const renderer = Description.parseRenderer(xml, device.descriptionUrl)

      assert.isTrue(Option.isSome(renderer), "the description did not parse as a renderer")
      yield* Option.match(renderer, {
        onNone: () => Effect.void,
        onSome: (found) =>
          Effect.sync(() => {
            assert.strictEqual(found.friendlyName, "Emulated Plasma")
            // Resolved against the description's own URL, which is what makes
            // the relative form usable at all.
            assert.strictEqual(found.avTransport.controlUrl, avTransport(device))
            assert.deepStrictEqual(
              Option.map(found.renderingControl, (service) => service.controlUrl),
              // Volume is the second service, and a renderer that omitted it
              // would still be playable — so its presence is worth asserting
              // rather than assuming.
              Option.some(renderingControl(device))
            )
          })
      })
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("answers anything else with a 404 rather than an empty 200", () =>
    Effect.gen(function*() {
      const device = yield* DlnaDevice.make()
      const response = yield* HttpClient.get(`http://127.0.0.1:${device.port}/nothing-here`)

      assert.strictEqual(response.status, 404)
    }).pipe(Effect.scoped, Effect.provide(TestServices)))
})

describe("playback", () => {
  it.live("fetches the URL it was given, which is the half that matters", () =>
    Effect.gen(function*() {
      const media = yield* mediaServer
      const device = yield* DlnaDevice.make()
      const url = media.url("/film.mp4")

      yield* load(device, url)

      // Setting the URI does not start anything. A device that pulled here
      // would hide a controller that never sent `Play`.
      assert.deepStrictEqual(yield* device.fetched, [])
      assert.strictEqual(yield* device.transportState, "STOPPED")

      const stored = yield* device.loaded
      assert.isTrue(Option.isSome(stored), "SetAVTransportURI was not recorded")
      assert.deepStrictEqual(
        Option.map(stored, (info) => info.uri),
        Option.some(url)
      )
      // The metadata is what gives the set a title and a seek bar; a controller
      // that sends a bare URL is the commonest cause of a film that plays with
      // its own URL as its name.
      assert.isTrue(
        Option.getOrElse(
          Option.map(stored, (info) => info.metadata.includes("Test Pattern")),
          () => false
        ),
        "the DIDL-Lite metadata did not reach the device"
      )

      yield* invoke(avTransport(device), Actions.play({ InstanceID: INSTANCE, Speed: "1" }))

      // The device really went and asked for it — this is the assertion the
      // whole emulator exists for. The media server saw the request...
      const hit = yield* Effect.timeoutOption(Queue.take(media.hits), Duration.seconds(5))
      assert.deepStrictEqual(hit, Option.some("/film.mp4"))

      // ...and the device recorded the pull, which is what a test that has no
      // media server of its own can assert on.
      yield* eventually(device.fetched, (all) => all.length > 0)
      assert.deepStrictEqual(yield* device.fetched, [url])
      assert.strictEqual(yield* device.transportState, "PLAYING")
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("changes state on pause and stop, and says so when asked", () =>
    Effect.gen(function*() {
      const media = yield* mediaServer
      const device = yield* DlnaDevice.make()

      yield* load(device, media.url("/film.mp4"))
      yield* invoke(avTransport(device), Actions.play({ InstanceID: INSTANCE, Speed: "1" }))
      yield* invoke(avTransport(device), Actions.pause({ InstanceID: INSTANCE }))

      assert.strictEqual(yield* device.transportState, "PAUSED_PLAYBACK")
      // `PAUSED_PLAYBACK`, not `PAUSED`: the AVTransport state names are not
      // the ones a controller would invent, and a controller matching on the
      // shorter name silently never sees a paused device.
      const paused = yield* outputsOf(
        avTransport(device),
        Actions.getTransportInfo({ InstanceID: INSTANCE })
      )
      assert.strictEqual(paused["CurrentTransportState"], "PAUSED_PLAYBACK")

      yield* invoke(avTransport(device), Actions.stop({ InstanceID: INSTANCE }))

      assert.strictEqual(yield* device.transportState, "STOPPED")
      const stopped = yield* outputsOf(
        avTransport(device),
        Actions.getTransportInfo({ InstanceID: INSTANCE })
      )
      assert.strictEqual(stopped["CurrentTransportState"], "STOPPED")
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("records where a seek was aimed, and reports it back as a position", () =>
    Effect.gen(function*() {
      const media = yield* mediaServer
      const device = yield* DlnaDevice.make()

      yield* load(device, media.url("/film.mp4"))
      yield* invoke(avTransport(device), Actions.play({ InstanceID: INSTANCE, Speed: "1" }))
      yield* invoke(
        avTransport(device),
        Actions.seek({ InstanceID: INSTANCE, Unit: "REL_TIME", Target: "0:01:23" })
      )

      assert.deepStrictEqual(yield* device.seekedTo, Option.some("0:01:23"))

      const position = yield* outputsOf(
        avTransport(device),
        Actions.getPositionInfo({ InstanceID: INSTANCE })
      )
      // `H:MM:SS` with the hours unpadded, which is how the specification
      // writes a duration and what several devices insist on receiving.
      assert.strictEqual(position["RelTime"], "0:01:23")
      // `AbsTime` is not an alternative source for it: most devices answer
      // exactly this, and a controller reading it draws a bar that never moves.
      assert.strictEqual(position["AbsTime"], "NOT_IMPLEMENTED")
    }).pipe(Effect.scoped, Effect.provide(TestServices)))
})

describe("rendering control", () => {
  it.live("round-trips a volume", () =>
    Effect.gen(function*() {
      const device = yield* DlnaDevice.make()

      yield* invoke(
        renderingControl(device),
        Actions.setVolume({
          InstanceID: INSTANCE,
          // The only channel every device implements; `LF` and `RF` exist and
          // are widely unsupported.
          Channel: "Master",
          // Whole percent, where Cast counts 0..1 — the controller multiplies
          // by a hundred on the way here.
          DesiredVolume: "42"
        })
      )

      assert.strictEqual(yield* device.volume, 42)

      const outputs = yield* outputsOf(
        renderingControl(device),
        Actions.getVolume({ InstanceID: INSTANCE, Channel: "Master" })
      )
      // A string on the wire and a string here: read as a number, a volume of
      // `07` becomes 7 and an id elsewhere loses a leading zero.
      assert.strictEqual(outputs["CurrentVolume"], "42")
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("does not answer a volume enquiry sent to the wrong service", () =>
    Effect.gen(function*() {
      // The control URL is what routes a request on a real device, so
      // `GetVolume` posted at AVTransport is an action that service does not
      // have. A controller with its two URLs swapped has to fail here.
      const device = yield* DlnaDevice.make()
      const answer = yield* invoke(
        avTransport(device),
        Actions.getVolume({ InstanceID: INSTANCE, Channel: "Master" })
      )

      assert.strictEqual(answer.status, 500)
      assert.deepStrictEqual(
        Option.map(Soap.parseFault(answer.body), (fault) => fault.code),
        Option.some("401")
      )
    }).pipe(Effect.scoped, Effect.provide(TestServices)))
})

describe("an action the device does not have", () => {
  it.live("is a UPnP fault, not a transport failure", () =>
    Effect.gen(function*() {
      const device = yield* DlnaDevice.make()
      const answer = yield* invoke(avTransport(device), {
        service: Actions.AVTransport,
        // Optional actions are refused exactly like invented ones, which is why
        // this matters: `Next`, `Previous` and `SetPlayMode` answer 401 on most
        // televisions, and a controller that reads a fault as a broken
        // connection reports a working set as broken.
        name: "Levitate",
        args: [["InstanceID", INSTANCE]]
      })

      assert.strictEqual(answer.status, 500)

      const fault = Soap.parseFault(answer.body)
      assert.isTrue(Option.isSome(fault), "the refusal was not a readable UPnP fault")
      assert.deepStrictEqual(
        Option.map(fault, (found) => found.code),
        Option.some("401")
      )
      assert.deepStrictEqual(
        Option.map(fault, (found) => found.description),
        Option.some("Invalid Action")
      )

      // And it is not mistakable for a successful answer to the action that was
      // sent, which is what a controller pipelining requests would do with it.
      assert.isTrue(Option.isNone(Soap.parseResponse(answer.body, "Levitate")))
    }).pipe(Effect.scoped, Effect.provide(TestServices)))
})

// The SSDP half is tested as text rather than over a socket: port 1900 is
// fixed, and a machine with a media server on it already has something bound
// there. The two halves that have to agree are the search the controller writes
// and the reply the device writes, and both are pure.
describe("ssdp", () => {
  const DESCRIPTION = "http://127.0.0.1:8060/description.xml"
  const UDN = "uuid:00000000-0000-1000-8000-000000008060"

  it("answers a search for a renderer", () => {
    assert.deepStrictEqual(
      DlnaDevice.searchTargetOf(Ssdp.searchFor(Ssdp.MEDIA_RENDERER)),
      Option.some(Ssdp.MEDIA_RENDERER)
    )
  })

  it("answers a sweep with what it actually is", () => {
    // `ssdp:all` is a question, not a target: echoing it back would tell the
    // control point nothing about what answered.
    assert.deepStrictEqual(
      DlnaDevice.searchTargetOf(Ssdp.searchFor("ssdp:all")),
      Option.some(Ssdp.MEDIA_RENDERER)
    )
  })

  it("answers a search for root devices, which several control points send", () => {
    // A device that answers only its own type is invisible to a controller that
    // sweeps for `upnp:rootdevice` and reads the type out of each description
    // — which reads as "it works in one app and not the other".
    assert.deepStrictEqual(
      DlnaDevice.searchTargetOf(Ssdp.searchFor("upnp:rootdevice")),
      Option.some("upnp:rootdevice")
    )
  })

  it("stays silent for somebody else's search", () => {
    assert.deepStrictEqual(
      DlnaDevice.searchTargetOf(Ssdp.searchFor("urn:schemas-upnp-org:device:MediaServer:1")),
      Option.none()
    )
  })

  it("stays silent for an announcement rather than treating it as a search", () => {
    // `NOTIFY` arrives on the same port and carries an `ST`-shaped `NT`. A
    // device that answered one would reply to every other device on the wire.
    assert.deepStrictEqual(
      DlnaDevice.searchTargetOf(
        [
          "NOTIFY * HTTP/1.1",
          "HOST: 239.255.255.250:1900",
          "NT: upnp:rootdevice",
          "NTS: ssdp:alive",
          "ST: upnp:rootdevice",
          "MAN: \"ssdp:discover\"",
          "MX: 2",
          "",
          ""
        ].join("\r\n")
      ),
      Option.none()
    )
  })

  it("stays silent for a search with no MAN, as real firmware does", () => {
    // The quotation marks are part of the token and the comparison is literal.
    // A control point that omits the header, or sends it unquoted, gets silence
    // from a room full of televisions and no indication of why.
    assert.deepStrictEqual(
      DlnaDevice.searchTargetOf(
        ["M-SEARCH * HTTP/1.1", "HOST: 239.255.255.250:1900", "MX: 2", "ST: ssdp:all", "", ""]
          .join("\r\n")
      ),
      Option.none()
    )
  })

  it("is readable by the discovery it exists to be found by", () => {
    // The reply the device writes and the parser the controller reads it with
    // are two halves of one format; they only agree if both are right.
    const found = Ssdp.parseResponse(
      DlnaDevice.searchResponsePacket(Ssdp.MEDIA_RENDERER, DESCRIPTION, UDN)
    )

    assert.deepStrictEqual(
      Option.map(found, (device) => device.location),
      Option.some(DESCRIPTION)
    )
    // The USN is the device identity joined to the target answered, and it is
    // the key a control point deduplicates three copies of one television on.
    assert.deepStrictEqual(
      Option.map(found, (device) => device.usn),
      Option.some(`${UDN}::${Ssdp.MEDIA_RENDERER}`)
    )
    assert.deepStrictEqual(
      Option.map(found, (device) => device.searchTarget),
      Option.some(Option.some(Ssdp.MEDIA_RENDERER))
    )
  })

  it("carries the EXT header, which is mandatory and always empty", () => {
    // It exists only to assert that the device understood the `MAN` it was
    // sent; strict control points reject a reply without one.
    assert.include(
      DlnaDevice.searchResponsePacket(Ssdp.MEDIA_RENDERER, DESCRIPTION, UDN),
      "\r\nEXT:\r\n"
    )
  })
})
