// An AirPlay receiver, emulated well enough to test against.
//
// Supports pairing-required mode (like tvOS 10.2+) where unauthenticated
// /play is rejected and pair-verify must complete first.

import { Effect, Layer, Match, Option, Queue, Ref, Schema, Scope, Stream } from "effect"
import { Brands } from "@castcli/domain"
import { HttpClient } from "effect/unstable/http"
import { Mdns } from "@castcli/platform"
import { NodeCrypto } from "@effect/platform-node"
import * as http from "node:http"

export interface AirPlayDevice {
  readonly port: Brands.Port
  readonly name: string
  readonly loaded: Effect.Effect<Option.Option<{ url: string; position: number }>>
  readonly fetched: Effect.Effect<ReadonlyArray<string>>
  readonly rate: Effect.Effect<number>
  readonly position: Effect.Effect<number>
}

const bodyOf = (request: http.IncomingMessage): Effect.Effect<Uint8Array> =>
  Effect.callback<Uint8Array>((resume) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resume(Effect.succeed(new Uint8Array(Buffer.concat(chunks)))))
    request.on("error", () => resume(Effect.succeed(new Uint8Array(0))))
  })

interface Answer {
  readonly status: number
  readonly body: Uint8Array | string
  readonly contentType?: string
}

const NOT_FOUND: Answer = { status: 404, body: "" }
const FORBIDDEN: Answer = { status: 403, body: "Pairing required" }

export const make = (options: {
  readonly name?: string
  readonly advertise?: boolean
  readonly requirePairing?: boolean
} = {}): Effect.Effect<AirPlayDevice, never, Scope.Scope | HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const name = options.name ?? "Emulated AirPlay"
    const requirePairing = options.requirePairing ?? false

    const loaded = yield* Ref.make(Option.none<{ url: string; position: number }>())
    const fetched = yield* Ref.make<ReadonlyArray<string>>([])
    const rateRef = yield* Ref.make(1)
    const position = yield* Ref.make(0)
    const pairVerified = yield* Ref.make(!requirePairing)

    const client = yield* HttpClient.HttpClient
    const pulls = yield* Queue.unbounded<string>()

    const pull = (url: string) =>
      Effect.gen(function*() {
        yield* client.get(url).pipe(Effect.flatMap((r) => r.arrayBuffer))
        yield* Ref.update(fetched, (all) => [...all, url])
      }).pipe(Effect.orElseSucceed(() => undefined))

    yield* Effect.forkScoped(Stream.runForEach(Stream.fromQueue(pulls), pull))

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
      () => Effect.sync(() => { server.closeAllConnections(); server.close() })
    )

    const address = server.address()
    const port = Brands.Port.make(
      address !== null && typeof address === "object" ? address.port : 7000
    )

    const handlePairVerify = (body: Uint8Array): Effect.Effect<Answer> =>
      requirePairing
        ? Effect.gen(function*() {
          const AirPlay = yield* Effect.promise(() => import("@castcli/airplay"))
          const { Items } = AirPlay.Tlv8
          const { TlvType } = AirPlay.GeneratedPairing

          const items = yield* Schema.decodeUnknownEffect(Items)(body).pipe(
            Effect.orElseSucceed((): ReadonlyArray<{ type: number; value: Uint8Array }> => [])
          )
          const stateItem = items.find((item) => item.type === TlvType.State)

          return yield* Option.match(
            Option.fromNullishOr(stateItem).pipe(
              Option.filter((item): item is { type: number; value: Uint8Array } =>
                typeof item === "object" && item !== null && "value" in item && item.value instanceof Uint8Array && item.value.length > 0
              )
            ),
            {
              onNone: () => Effect.succeed({ status: 400, body: "Missing state" } satisfies Answer),
              onSome: (stateEntry) => Effect.gen(function*() {
                const pairVerifyState = stateEntry.value[0]

                return yield* Match.value(pairVerifyState).pipe(
                  Match.when(1, () => Effect.gen(function*() {
                    const controllerPubKey = items.find((entry: unknown) =>
                      typeof entry === "object" &&
                      entry !== null &&
                      "type" in entry &&
                      typeof entry.type === "number" &&
                      entry.type === TlvType.PublicKey
                    )

                    return yield* Option.match(
                      Option.fromNullishOr(controllerPubKey),
                      {
                        onNone: () => Effect.succeed({ status: 400, body: "Missing public key" } satisfies Answer),
                        onSome: () => Effect.gen(function*() {
                          const suite = yield* Effect.provide(AirPlay.Suite.Suite, Layer.provide(AirPlay.NodeSuite, NodeCrypto.layer))
                          const accessoryEphemeral = yield* suite.x25519KeyPair
                          const accessoryEphemeralPublic = yield* suite.x25519PublicKey(
                            accessoryEphemeral.privateKey
                          )

                          const m2 = [
                            { type: TlvType.State, value: new Uint8Array([2]) },
                            { type: TlvType.PublicKey, value: accessoryEphemeralPublic }
                          ]
                          const m2Bytes = yield* Schema.encodeEffect(Items)(m2).pipe(
                            Effect.orElseSucceed(() => new Uint8Array(0))
                          )

                          return { status: 200, body: m2Bytes, contentType: "application/octet-stream" } satisfies Answer
                        })
                      }
                    )
                  })),
                  Match.when(3, () => Effect.gen(function*() {
                    yield* Ref.set(pairVerified, true)

                    const m4 = [{ type: TlvType.State, value: new Uint8Array([4]) }]
                    const m4Bytes = yield* Schema.encodeEffect(Items)(m4).pipe(
                      Effect.orElseSucceed(() => new Uint8Array(0))
                    )

                    return { status: 200, body: m4Bytes, contentType: "application/octet-stream" } satisfies Answer
                  })),
                  Match.orElse(() => Effect.succeed({ status: 400, body: "Invalid state" } satisfies Answer))
                )
              })
            }
          )
        }).pipe(Effect.orElseSucceed(() => ({ status: 500, body: "Internal error" })))
        : Effect.succeed(NOT_FOUND)

    const answer = (request: http.IncomingMessage): Effect.Effect<Answer> =>
      Effect.gen(function*() {
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
        const path = url.pathname
        const method = request.method ?? "GET"
        const body = yield* bodyOf(request)

        return yield* Match.value({ path, method }).pipe(
          Match.when({ path: "/pair-verify", method: "POST" }, () => handlePairVerify(body)),

          Match.when({ path: "/play", method: "POST" }, () =>
            Effect.gen(function*() {
              const verified = yield* Ref.get(pairVerified)
              return yield* (verified
                ? Effect.gen(function*() {
                  const params = url.searchParams
                  const contentLocation = params.get("Content-Location") ?? ""
                  const startPosition = Number(params.get("Start-Position") ?? "0")

                  yield* Effect.when(
                    Effect.gen(function*() {
                      yield* Ref.set(loaded, Option.some({ url: contentLocation, position: startPosition }))
                      yield* Ref.set(position, startPosition)
                      yield* Ref.set(rateRef, 1)
                      yield* Queue.offer(pulls, contentLocation)
                    }),
                    Effect.succeed(contentLocation.length > 0)
                  )

                  return { status: 200, body: "" }
                })
                : Effect.succeed(FORBIDDEN)
              )
            })),

          Match.when({ path: "/command", method: "POST" }, () =>
            Effect.gen(function*() {
              const verified = yield* Ref.get(pairVerified)
              return yield* (verified
                ? Effect.gen(function*() {
                  const bodyText = new TextDecoder().decode(body)
                  const urlMatch = bodyText.match(/Content-Location.*?<string>(.*?)<\/string>/s)
                  const posMatch = bodyText.match(/Start-Position.*?<real>([\d.]+)<\/real>/s)

                  yield* Effect.when(
                    Effect.gen(function*() {
                      const contentLocation = yield* Option.match(
                        Option.fromNullishOr(urlMatch).pipe(
                          Option.flatMap((match) => Option.fromNullishOr(match[1]))
                        ),
                        {
                          onNone: () => Effect.succeed(""),
                          onSome: (contentUrl) => Effect.succeed(contentUrl)
                        }
                      )
                      const startPosition = posMatch ? Number(posMatch[1]) : 0

                      yield* Ref.set(loaded, Option.some({ url: contentLocation, position: startPosition }))
                      yield* Ref.set(position, startPosition)
                      yield* Ref.set(rateRef, 1)
                      yield* Queue.offer(pulls, contentLocation)
                    }),
                    Effect.succeed(urlMatch !== null && urlMatch[1] !== undefined)
                  )

                  return { status: 200, body: "" }
                })
                : Effect.succeed(FORBIDDEN)
              )
            })),

          Match.when({ path: "/scrub", method: "POST" }, () =>
            Effect.gen(function*() {
              const positionParam = url.searchParams.get("position")
              yield* Effect.when(
                Effect.gen(function*() {
                  yield* Ref.set(position, Number(positionParam))
                }),
                Effect.succeed(positionParam !== null)
              )
              return { status: 200, body: "" }
            })),

          Match.when({ path: "/rate", method: "POST" }, () =>
            Effect.gen(function*() {
              const value = url.searchParams.get("value")
              yield* Effect.when(
                Effect.gen(function*() {
                  yield* Ref.set(rateRef, Number(value))
                }),
                Effect.succeed(value !== null)
              )
              return { status: 200, body: "" }
            })),

          Match.when({ path: "/stop", method: "POST" }, () =>
            Effect.gen(function*() {
              yield* Ref.set(rateRef, 0)
              yield* Ref.set(position, 0)
              return { status: 200, body: "" }
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
              return { status: 200, body: plist, contentType: "text/x-apple-plist+xml" }
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
            const bodyToSend = typeof written.body === "string" ? written.body : Buffer.from(written.body)
            response.end(bodyToSend)
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
    }
  })
