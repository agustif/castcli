// The renderer session, driven over a real socket at a scripted television.
//
// `Renderer` was the one module here written against the specification rather
// than against anything that answers, and the parts that were wrong were all
// wrong at the edges: what leaves on the wire, and what a device says when it
// is not saying yes. So this exercises it through an HTTP server rather than
// through a stubbed client — the request headers a device actually receives are
// half of what is being tested, and a stub would have echoed back whatever the
// code believed it was sending.
//
// `it.live` throughout, not `it.effect`: the latter supplies a TestClock whose
// time never advances, and every one of these waits on a socket.

import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option, Queue } from "effect"
import { NodeServices } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Brands } from "@castcli/domain"
import * as http from "node:http"
import * as Description from "../src/Description.ts"
import * as Renderer from "../src/Renderer.ts"
import * as Soap from "../src/Soap.ts"

const TestServices = Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)

const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1"

/** What a request looked like by the time it reached the far end. */
interface Received {
  readonly contentType: string
  readonly soapAction: string
  readonly body: string
}

/** How a scripted device answers one action. */
interface Answer {
  readonly status: number
  readonly body: string
}

/** A successful answer to `action`, built by the module that reads them. */
const answering = (
  action: string,
  outputs: ReadonlyArray<readonly [string, string]>
): Answer => ({
  status: 200,
  body: Soap.envelope({ service: AV_TRANSPORT, name: `${action}Response`, args: outputs })
})

/**
 * A description with one service, whose control URL is relative — as a real
 * device writes it, and as `Description` resolves it.
 */
const DESCRIPTION = `<?xml version="1.0"?>` +
  `<root xmlns="urn:schemas-upnp-org:device-1-0"><device>` +
  `<friendlyName>Scripted Plasma</friendlyName><serviceList><service>` +
  `<serviceType>${AV_TRANSPORT}</serviceType>` +
  `<controlURL>AVTransport/control</controlURL>` +
  `</service></serviceList></device></root>`

/**
 * A television whose every answer is written by the test.
 *
 * The action name comes out of the `SOAPAction` header rather than the body,
 * because that is what a device routes on and because a test that read the body
 * to decide what to answer could not answer a request whose body it did not
 * understand — which is half of what is being checked here.
 */
const scripted = (reply: (action: string) => Answer) =>
  Effect.gen(function*() {
    const received = yield* Queue.unbounded<Received>()
    const server = http.createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
      })
      request.on("end", () => {
        const soapAction = String(request.headers["soapaction"] ?? "")
        Queue.offerUnsafe(received, {
          contentType: String(request.headers["content-type"] ?? ""),
          soapAction,
          body: Buffer.concat(chunks).toString("utf8")
        })
        const answer = reply(soapAction.replaceAll(`"`, "").split("#")[1] ?? "")
        response.writeHead(answer.status, { "content-type": "text/xml" })
        response.end(answer.body)
      })
    })

    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.listen(0, "127.0.0.1", () => resume(Effect.void))
      }),
      () =>
        Effect.sync(() => {
          // Connections first: `close` alone waits out the keep-alive socket the
          // client left open, and vitest would sit there waiting with it.
          server.closeAllConnections()
          server.close()
        })
    )

    const address = server.address()
    const port = address !== null && typeof address === "object" ? address.port : 0
    const location = `http://127.0.0.1:${port}/description.xml`

    return { location, received }
  })

/** Connect to a scripted device, reading its description the way `scan` does. */
const connect = (location: string) =>
  Option.match(Description.parseRenderer(DESCRIPTION, location), {
    onNone: () => Effect.die("the fixture description did not parse"),
    onSome: (device) => Renderer.connect(device)
  })

/** The failure message, for a call that is expected to produce one. */
const failureOf = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
  Effect.match(effect, {
    onFailure: (error) => error.message,
    onSuccess: () => "unexpectedly succeeded"
  })

/** The one argument of the last request, read back out of the envelope sent. */
const argumentOf = (received: Received, name: string): Option.Option<string> =>
  Option.fromNullishOr(
    new RegExp(`<${name}>([^<]*)</${name}>`).exec(received.body)?.[1]
  )

describe("what leaves on the wire", () => {
  it.live("carries the content type UPnP fixes, charset and all", () =>
    Effect.gen(function*() {
      const device = yield* scripted((action) => answering(action, []))
      const renderer = yield* connect(device.location)

      yield* renderer.pause

      const sent = yield* Queue.takeAll(device.received)
      const request = Option.fromNullishOr([...sent][0])

      // The header used to be set on the request and then silently replaced:
      // `HttpClientRequest.post` applies `headers` before `body`, and setting a
      // body overwrites `content-type` with the body's own. So the envelope
      // went out as bare `text/xml` however loudly the call site asked for the
      // charset, and the one device that insists on it would have answered 500
      // with nothing to explain why.
      assert.deepStrictEqual(
        Option.map(request, (one) => one.contentType),
        Option.some(`text/xml; charset="utf-8"`)
      )
      // Quoted, and part of the value rather than punctuation: sent bare, the
      // identical envelope comes back as "401 Invalid Action".
      assert.deepStrictEqual(
        Option.map(request, (one) => one.soapAction),
        Option.some(`"${AV_TRANSPORT}#Pause"`)
      )
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("writes a seek past the hour as H:MM:SS, hours unpadded", () =>
    Effect.gen(function*() {
      const device = yield* scripted((action) => answering(action, []))
      const renderer = yield* connect(device.location)

      // Deliberately over an hour and not a round number: the minutes field is
      // `(whole / 60) % 60` and the seconds `whole % 60`, and either one
      // written without its modulus survives every duration under an hour.
      yield* renderer.seek(Brands.Seconds.make(3661))

      const sent = yield* Queue.takeAll(device.received)
      assert.deepStrictEqual(
        Option.flatMap(Option.fromNullishOr([...sent][0]), (one) => argumentOf(one, "Target")),
        Option.some("1:01:01")
      )
    }).pipe(Effect.scoped, Effect.provide(TestServices)))
})

describe("reading a position back", () => {
  const reportingPosition = (relTime: string, state = "PLAYING") =>
    scripted((action) =>
      action === "GetTransportInfo"
        ? answering(action, [
          ["CurrentTransportState", state],
          ["CurrentTransportStatus", "OK"],
          ["CurrentSpeed", "1"]
        ])
        : answering(action, [["Track", "1"], ["RelTime", relTime]])
    )

  it.live("round-trips a position past the hour", () =>
    Effect.gen(function*() {
      const device = yield* reportingPosition("1:01:01")
      const renderer = yield* connect(device.location)

      assert.deepStrictEqual(
        Option.flatMap(yield* renderer.status, (playback) => playback.position),
        Option.some(Brands.Seconds.make(3661))
      )
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("reads a position of exactly zero as a position, not as absence", () =>
    Effect.gen(function*() {
      const device = yield* reportingPosition("0:00:00")
      const renderer = yield* connect(device.location)

      assert.deepStrictEqual(
        Option.flatMap(yield* renderer.status, (playback) => playback.position),
        Option.some(Brands.Seconds.make(0))
      )
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("keeps the reading when the device sends a state it was not asked for", () =>
    Effect.gen(function*() {
      // `PAUSED_RECORDING` is in AVTransport:1 and was missing from the closed
      // set this decoded against, so the whole answer — the position with it —
      // was discarded over one word. That is the mistake the Cast side already
      // made once with `PlayerState` and fixed by widening; here it cost the
      // position, which `cast play` saves every second as the resume point.
      const device = yield* reportingPosition("0:04:10", "PAUSED_RECORDING")
      const renderer = yield* connect(device.location)

      assert.deepStrictEqual(
        Option.flatMap(yield* renderer.status, (playback) => playback.position),
        Option.some(Brands.Seconds.make(250))
      )
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("keeps the reading when the state is a word nobody knows", () =>
    Effect.gen(function*() {
      // Vendors invent these. The state itself becomes the least wrong of the
      // four words a caller can act on; the point of the test is that the
      // position survives rather than the whole answer being dropped.
      const device = yield* reportingPosition("0:04:10", "X_SONY_SOMETHING")
      const renderer = yield* connect(device.location)
      const status = yield* renderer.status

      assert.deepStrictEqual(
        Option.flatMap(status, (playback) => playback.position),
        Option.some(Brands.Seconds.make(250))
      )
      assert.deepStrictEqual(
        Option.map(status, (playback) => playback.state),
        Option.some("TRANSITIONING")
      )
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("treats no media at all as stopped", () =>
    Effect.gen(function*() {
      const device = yield* reportingPosition("0:00:00", "NO_MEDIA_PRESENT")
      const renderer = yield* connect(device.location)

      assert.deepStrictEqual(
        Option.map(yield* renderer.status, (playback) => playback.state),
        Option.some("STOPPED")
      )
    }).pipe(Effect.scoped, Effect.provide(TestServices)))
})

describe("what a device says when it is not saying yes", () => {
  it.live("names the status when the body is not SOAP at all", () =>
    Effect.gen(function*() {
      // The shape of a control URL that was never resolved, or a device that
      // moved its services: a web server answering 404 in HTML. The status is
      // the whole diagnosis and it used to be thrown away, leaving a message
      // about somebody else's reply that sent the reader hunting a pipelining
      // bug that does not exist.
      const device = yield* scripted(() => ({
        status: 404,
        body: "<html><body><h1>404 Not Found</h1></body></html>"
      }))
      const renderer = yield* connect(device.location)

      const message = yield* failureOf(renderer.pause)
      assert.include(message, "404")
      assert.include(message, "Pause")
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("names the status when a 500 carries no fault", () =>
    Effect.gen(function*() {
      // A device that fell over rather than one that declined: 500 is what both
      // look like from outside, and only the body separates them.
      const device = yield* scripted(() => ({ status: 500, body: "" }))
      const renderer = yield* connect(device.location)

      assert.include(yield* failureOf(renderer.pause), "500")
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("still reports the fault code when the device omits the description", () =>
    Effect.gen(function*() {
      // Several renderers send the code alone. Interpolated into "refused: %s
      // (%s)" that produced `Pause refused:  (701)` — a sentence with a hole in
      // it, where 701 is the entire message: told to play with nothing loaded.
      const device = yield* scripted(() => ({
        status: 500,
        body: `<?xml version="1.0"?>` +
          `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
          `<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>` +
          `<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">` +
          `<errorCode>701</errorCode></UPnPError></detail>` +
          `</s:Fault></s:Body></s:Envelope>`
      }))
      const renderer = yield* connect(device.location)

      const message = yield* failureOf(renderer.pause)
      assert.include(message, "701")
      assert.notInclude(message, ":  (")
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("still reads a fault that arrives with a 200, as some devices send it", () =>
    Effect.gen(function*() {
      const device = yield* scripted(() => ({
        status: 200,
        body: `<?xml version="1.0"?>` +
          `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
          `<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>` +
          `<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">` +
          `<errorCode>716</errorCode>` +
          `<errorDescription>Resource not found</errorDescription>` +
          `</UPnPError></detail></s:Fault></s:Body></s:Envelope>`
      }))
      const renderer = yield* connect(device.location)

      const message = yield* failureOf(renderer.pause)
      // 716 is the fault that means the device could not fetch the URL we gave
      // it — nearly always our own address being one it cannot route to — so it
      // is the one worth surviving intact.
      assert.include(message, "716")
      assert.include(message, "Resource not found")
    }).pipe(Effect.scoped, Effect.provide(TestServices)))

  it.live("gives up on a device that accepts the connection and never answers", () =>
    Effect.gen(function*() {
      // A television that went to sleep mid-session: the socket still connects,
      // the request is still accepted, and nothing ever comes back. Without a
      // limit of our own this waited on TCP's, in minutes, per attempt — the
      // same failure `CastSocket` had to be given a connect timeout to fix, and
      // it looks identical from outside: a command that prints nothing and
      // hangs.
      const stalled = yield* Effect.gen(function*() {
        const server = http.createServer(() => {})
        yield* Effect.acquireRelease(
          Effect.callback<void>((resume) => {
            server.listen(0, "127.0.0.1", () => resume(Effect.void))
          }),
          () =>
            Effect.sync(() => {
              server.closeAllConnections()
              server.close()
            })
        )
        const address = server.address()
        const port = address !== null && typeof address === "object" ? address.port : 0
        return `http://127.0.0.1:${port}/description.xml`
      })

      const renderer = yield* connect(stalled)
      const message = yield* Effect.timeoutOption(
        failureOf(renderer.pause),
        // Comfortably outside the request timeout and comfortably inside TCP's
        // own, so the assertion is about ours having fired rather than about
        // the operating system eventually noticing.
        Duration.seconds(20)
      )

      assert.isTrue(Option.isSome(message), "the request never settled")
      yield* Option.match(message, {
        onNone: () => Effect.void,
        onSome: (said) => Effect.sync(() => assert.include(said, "did not answer"))
      })
    }).pipe(Effect.scoped, Effect.provide(TestServices)), { timeout: 30_000 })
})
