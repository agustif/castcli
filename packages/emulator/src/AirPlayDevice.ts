// An AirPlay receiver, emulated well enough to test against.
//
// Like DlnaDevice, it speaks HTTP: mDNS to be found, and simple POST/GET
// endpoints for control. The critical half is the same: it *pulls* the media
// over HTTP, exactly as an Apple TV does, because `/play` hands it a URL and
// it fetches that URL.

import { Effect, Match, Option, Queue, Ref, Scope, Stream } from "effect"
import { Brands } from "@castcli/domain"
import { HttpClient } from "effect/unstable/http"
import { Mdns } from "@castcli/platform"
import * as http from "node:http"

export interface AirPlayDevice {
  readonly port: Brands.Port
  readonly name: string
  /** What /play was given, once it has been. */
  readonly loaded: Effect.Effect<Option.Option<{ url: string; position: number }>>
  /** Every URL this device pulled, in order. */
  readonly fetched: Effect.Effect<ReadonlyArray<string>>
  readonly rate: Effect.Effect<number>
  readonly position: Effect.Effect<number>
}

const bodyOf = (request: http.IncomingMessage): Effect.Effect<string> =>
  Effect.callback<string>((resume) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))))
    request.on("error", () => resume(Effect.succeed("")))
  })

interface Answer {
  readonly status: number
  readonly body: string
  readonly contentType?: string
}

const NOT_FOUND: Answer = { status: 404, body: "" }

export const make = (options: {
  readonly name?: string
  readonly advertise?: boolean
} = {}): Effect.Effect<AirPlayDevice, never, Scope.Scope | HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const name = options.name ?? "Emulated AirPlay"

    const loaded = yield* Ref.make(Option.none<{ url: string; position: number }>())
    const fetched = yield* Ref.make<ReadonlyArray<string>>([])
    const rateRef = yield* Ref.make(1)
    const position = yield* Ref.make(0)

    const client = yield* HttpClient.HttpClient

    const pulls = yield* Queue.unbounded<string>()

    const pull = (url: string) =>
      Effect.gen(function*() {
        const response = yield* client.get(url)
        yield* response.arrayBuffer
        yield* Ref.update(fetched, (all) => [...all, url])
      })

    yield* Effect.forkScoped(
      Stream.runForEach(
        Stream.fromQueue(pulls),
        (url) => pull(url).pipe(Effect.orElseSucceed(() => undefined))
      )
    )

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
        server.listen(0, "127.0.0.1", () => resume(Effect.void))
      }),
      () =>
        Effect.sync(() => {
          server.closeAllConnections()
          server.close()
        })
    )

    const address = server.address()
    const port = Brands.Port.make(
      address !== null && typeof address === "object" ? address.port : 7000
    )

    const answer = (request: http.IncomingMessage): Effect.Effect<Answer> =>
      Effect.gen(function*() {
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
        const path = url.pathname
        const method = request.method ?? "GET"
        yield* bodyOf(request) // Read body even if unused

        return yield* Match.value({ path, method }).pipe(
          Match.when({ path: "/play", method: "POST" }, () =>
            Effect.gen(function*() {
              const params = url.searchParams
              const contentLocation = params.get("Content-Location") ?? ""
              const startPosition = Number(params.get("Start-Position") ?? "0")

              yield* Ref.set(loaded, Option.some({ url: contentLocation, position: startPosition }))
              yield* Ref.set(position, startPosition)
              yield* Ref.set(rateRef, 1)

              yield* Effect.when(
                Queue.offer(pulls, contentLocation),
                Effect.succeed(contentLocation.length > 0)
              )

              return { status: 200, body: "" } satisfies Answer
            })),

          Match.when({ path: "/scrub", method: "POST" }, () =>
            Effect.gen(function*() {
              const positionParam = url.searchParams.get("position")
              yield* Option.match(Option.fromNullishOr(positionParam), {
                onNone: () => Effect.void,
                onSome: (value) => Ref.set(position, Number(value))
              })
              return { status: 200, body: "" } satisfies Answer
            })),

          Match.when({ path: "/rate", method: "POST" }, () =>
            Effect.gen(function*() {
              const value = url.searchParams.get("value")
              yield* Option.match(Option.fromNullishOr(value), {
                onNone: () => Effect.void,
                onSome: (v) => Ref.set(rateRef, Number(v))
              })
              return { status: 200, body: "" } satisfies Answer
            })),

          Match.when({ path: "/stop", method: "POST" }, () =>
            Effect.gen(function*() {
              yield* Ref.set(rateRef, 0)
              yield* Ref.set(position, 0)
              return { status: 200, body: "" } satisfies Answer
            })),

          Match.when({ path: "/playback-info", method: "GET" }, () =>
            Effect.gen(function*() {
              const currentRate = yield* Ref.get(rateRef)
              const currentPosition = yield* Ref.get(position)
              const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>duration</key><real>0</real>
  <key>position</key><real>${currentPosition}</real>
  <key>rate</key><real>${currentRate}</real>
  <key>readyToPlay</key><true />
</dict>
</plist>`
              return { status: 200, body: plist, contentType: "text/x-apple-plist+xml" } satisfies Answer
            })),

          Match.orElse(() => Effect.succeed(NOT_FOUND))
        )
      })

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(requests), ({ request, response }) =>
        Effect.flatMap(answer(request), (written) =>
          Effect.sync(() => {
            response.writeHead(written.status, {
              "content-type": written.contentType ?? "text/plain"
            })
            response.end(written.body)
          })))
    )

    yield* Effect.when(
      Mdns.advertiseAirPlay({ name, port }),
      Effect.succeed(options.advertise === true)
    )

    return {
      port,
      name,
      loaded: Ref.get(loaded),
      fetched: Ref.get(fetched),
      rate: Ref.get(rateRef),
      position: Ref.get(position)
    } satisfies AirPlayDevice
  })
