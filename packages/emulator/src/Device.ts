// A Google Cast device, emulated well enough to test against.
//
// A **device**, not a service: it owns its own TLS listener and there can be
// several at once on different ports, which is how a network with a TV and two
// speakers behaves. Nothing here is shared or global.
//
// It plays both halves of what a real receiver does, and the second half is the
// one that matters:
//
//   1. it *serves* the Cast control channel — length-prefixed protobuf over
//      TLS — answering CONNECT, GET_STATUS, LAUNCH and the media commands;
//   2. it *pulls* the media over HTTP, exactly as a receiver does: fetch the
//      content, and for HLS walk the master playlist to a variant and the
//      variant to its segments.
//
// The pull half is why this exists. Everything about serving a film to a Cast
// device is inverted — the device fetches from us — so a test that only checks
// what we *sent* checks the easy half. Here the emulated device really does
// request the playlists and segments, and a test can assert on what it got.

import { Data, Effect, Option, Queue, Ref, Schema, Scope, Stream } from "effect"
import { Brands } from "@castcli/domain"
import { Frame } from "@castcli/protocol"
import { HttpClient } from "effect/unstable/http"
import * as tls from "node:tls"
import * as Certificate from "./Certificate.ts"

const RECEIVER = "receiver-0"
const TRANSPORT = "emulated-transport-1"
const MEDIA_SESSION = 1

const Namespace = {
  connection: "urn:x-cast:com.google.cast.tp.connection",
  heartbeat: "urn:x-cast:com.google.cast.tp.heartbeat",
  receiver: "urn:x-cast:com.google.cast.receiver",
  media: "urn:x-cast:com.google.cast.media"
} as const

/** What the sender asked the device to play. */
export interface Loaded {
  readonly contentId: string
  readonly contentType: string
  readonly currentTime: number
  readonly hlsSegmentFormat: Option.Option<string>
  readonly trackContentIds: ReadonlyArray<string>
}

export type Playback = Data.TaggedEnum<{
  readonly Idle: {}
  readonly Playing: { readonly at: number }
  readonly Paused: { readonly at: number }
}>

export const Playback = Data.taggedEnum<Playback>()

export interface Device {
  /** Where the sender should connect. Each device has its own. */
  readonly port: Brands.Port
  /** What LOAD asked for, once one has arrived. */
  readonly loaded: Effect.Effect<Option.Option<Loaded>>
  /** Every URL the device fetched, in order — the point of the exercise. */
  readonly fetched: Effect.Effect<ReadonlyArray<string>>
  readonly playback: Effect.Effect<Playback>
  /** Wait until the device has pulled something, or give up. */
  readonly awaitFetch: (
    matching: (url: string) => boolean
  ) => Effect.Effect<Option.Option<string>>
}

/** The bodies the device pulled, so a test can look at what we served. */
interface Fetched {
  readonly url: string
  readonly status: number
  readonly body: string
}

const MEDIA_STATUS_LIMIT = 400

/**
 * Follow what a Cast receiver would follow.
 *
 * For HLS that means master playlist -> one variant -> its first segments. The
 * variant chosen is the *lowest* bitrate, which is what a real receiver does
 * before it has measured anything, and it keeps the test cheap: segments are
 * encoded on demand, so asking for the 1080p variant would burn CPU proving
 * nothing extra.
 */
const pull = (
  base: string,
  contentType: string,
  record: (fetched: Fetched) => Effect.Effect<void>,
  segments: number
) =>
  Effect.gen(function*() {
    const get = (url: string) =>
      Effect.gen(function*() {
        const response = yield* HttpClient.get(url)
        // A segment is binary and can be megabytes; its length is the
        // interesting part and decoding it as text helps nobody.
        const isSegment = url.endsWith(".ts")
        const body = isSegment
          ? `<${(yield* response.arrayBuffer).byteLength} bytes>`
          : yield* response.text
        return { url, status: response.status, body }
      }).pipe(Effect.tap(record))

    const master = yield* get(base)

    // Anything that is not a playlist is pulled whole and that is the end of
    // it, which is exactly how the progressive stream behaves.
    return yield* Effect.when(
      Effect.gen(function*() {
        const variant = Option.fromNullishOr(
          master.body.split("\n").map((line) => line.trim()).find((line) =>
            line.length > 0 && !line.startsWith("#")
          )
        )

        yield* Option.match(variant, {
          onNone: () => Effect.void,
          onSome: (path) =>
            Effect.gen(function*() {
              const media = yield* get(new URL(path, base).toString())
              const wanted = media.body
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0 && !line.startsWith("#"))
                .slice(0, segments)
              yield* Effect.forEach(
                wanted,
                (segment) => get(new URL(segment, base).toString()),
                { discard: true }
              )
            })
        })
      }),
      Effect.succeed(contentType.includes("mpegurl"))
    )
  })

/** The payload shapes the device needs to understand. Anything else is ignored. */
const Incoming = Schema.Struct({
  type: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.Number),
  currentTime: Schema.optional(Schema.Number),
  media: Schema.optional(
    Schema.Struct({
      contentId: Schema.String,
      contentType: Schema.String,
      hlsSegmentFormat: Schema.optional(Schema.String),
      tracks: Schema.optional(
        Schema.Array(Schema.Struct({ trackContentId: Schema.optional(Schema.String) }))
      )
    })
  )
})

const decodeIncoming = Schema.decodeUnknownOption(Schema.fromJsonString(Incoming))

/**
 * Start an emulated device.
 *
 * Scoped: the listener closes with the scope, so a test that fails still frees
 * its port.
 */
export const make = (options: {
  /** How many segments to pull before settling, for HLS content. */
  readonly segments?: number
} = {}): Effect.Effect<
  Device,
  never,
  Scope.Scope | Certificate.Certificate | HttpClient.HttpClient
> =>
  Effect.gen(function*() {
    const certificate = yield* Certificate.Certificate
    const loaded = yield* Ref.make(Option.none<Loaded>())
    const fetched = yield* Ref.make<ReadonlyArray<Fetched>>([])
    const playback = yield* Ref.make<Playback>(Playback.Idle())
    const launched = yield* Ref.make(false)
    const arrivals = yield* Queue.unbounded<string>()

    const record = (item: Fetched) =>
      Effect.andThen(
        Ref.update(fetched, (all) => [...all, item]),
        Queue.offer(arrivals, item.url)
      )

    const server = tls.createServer({ key: certificate.key, cert: certificate.cert })

    // Each connection is a sender. The framing is the project's own codec, run
    // in the opposite direction from production — which is itself worth having,
    // because a decoder that only ever meets its own encoder proves less.
    const handle = (socket: tls.TLSSocket) =>
      Effect.gen(function*() {
        const pending = yield* Ref.make<Buffer>(Buffer.alloc(0))
        const messages = yield* Queue.unbounded<Frame.CastMessage>()

        socket.on("data", (chunk: Buffer) => {
          Queue.offerUnsafe(messages, {
            sourceId: "",
            destinationId: "",
            namespace: "",
            payload: Frame.Payload.Binary({ value: chunk })
          })
        })

        // A real receiver answers from the address the sender wrote to: the
        // receiver itself for control, the media transport for playback. Get
        // this wrong and the sender ignores the reply as being from a stranger.
        const reply = (source: string, namespace: string, payload: unknown) =>
          Effect.sync(() =>
            socket.write(
              Frame.encodeFrame({
                sourceId: source,
                destinationId: "sender-0",
                namespace,
                payload: Frame.Payload.Text({ value: JSON.stringify(payload) })
              })
            )
          )

        const receiverStatus = (requestId: number) =>
          Effect.flatMap(Ref.get(launched), (isLaunched) =>
            reply(RECEIVER, Namespace.receiver, {
              type: "RECEIVER_STATUS",
              requestId,
              status: {
                applications: isLaunched
                  ? [
                    {
                      appId: "CC1AD845",
                      displayName: "Default Media Receiver",
                      sessionId: "emulated-session-1",
                      transportId: TRANSPORT,
                      statusText: "Ready to cast"
                    }
                  ]
                  : []
              }
            }))

        const mediaStatus = (requestId: number) =>
          Effect.flatMap(Ref.get(playback), (state) =>
            reply(TRANSPORT, Namespace.media, {
              type: "MEDIA_STATUS",
              requestId,
              status: Playback.$match(state, {
                Idle: () => [],
                Playing: ({ at }) => [
                  { mediaSessionId: MEDIA_SESSION, playerState: "PLAYING", currentTime: at }
                ],
                Paused: ({ at }) => [
                  { mediaSessionId: MEDIA_SESSION, playerState: "PAUSED", currentTime: at }
                ]
              })
            }))

        const onMessage = (message: Frame.CastMessage) =>
          Effect.gen(function*() {
            const payload = Frame.Payload.$match(message.payload, {
              Text: ({ value }) => Option.some(value),
              Binary: () => Option.none<string>()
            })

            yield* Option.match(Option.flatMap(payload, decodeIncoming), {
              onNone: () => Effect.void,
              onSome: (body) =>
                Effect.gen(function*() {
                  const requestId = body.requestId ?? 0

                  yield* Effect.when(
                    receiverStatus(requestId),
                    Effect.succeed(
                      message.namespace === Namespace.receiver && body.type === "GET_STATUS"
                    )
                  )

                  yield* Effect.when(
                    Effect.andThen(Ref.set(launched, true), receiverStatus(requestId)),
                    Effect.succeed(
                      message.namespace === Namespace.receiver && body.type === "LAUNCH"
                    )
                  )

                  yield* Effect.when(
                    Effect.sync(() =>
                      socket.write(
                        Frame.encodeFrame({
                          sourceId: RECEIVER,
                          destinationId: "sender-0",
                          namespace: Namespace.heartbeat,
                          payload: Frame.Payload.Text({ value: JSON.stringify({ type: "PONG" }) })
                        })
                      )
                    ),
                    Effect.succeed(message.namespace === Namespace.heartbeat)
                  )

                  // The one that matters: go and fetch what we were handed.
                  yield* Effect.when(
                    Effect.gen(function*() {
                      const media = Option.fromNullishOr(body.media)
                      yield* Option.match(media, {
                        onNone: () => Effect.void,
                        onSome: (info) =>
                          Effect.gen(function*() {
                            yield* Ref.set(
                              loaded,
                              Option.some({
                                contentId: info.contentId,
                                contentType: info.contentType,
                                currentTime: body.currentTime ?? 0,
                                hlsSegmentFormat: Option.fromNullishOr(info.hlsSegmentFormat),
                                trackContentIds: (info.tracks ?? []).flatMap((track) =>
                                  track.trackContentId === undefined ? [] : [track.trackContentId]
                                )
                              })
                            )
                            yield* Ref.set(playback, Playback.Playing({ at: body.currentTime ?? 0 }))
                            yield* mediaStatus(requestId)
                            // Forked: a real receiver answers LOAD and pulls in
                            // its own time, and holding the control channel
                            // while megabytes transfer would be a lie.
                            yield* Effect.forkScoped(
                              pull(
                                info.contentId,
                                info.contentType,
                                record,
                                options.segments ?? 2
                              ).pipe(Effect.orElseSucceed(() => undefined))
                            )
                            yield* Effect.forEach(
                              (info.tracks ?? []).flatMap((track) =>
                                track.trackContentId === undefined ? [] : [track.trackContentId]
                              ),
                              (url) =>
                                Effect.forkScoped(
                                  pull(url, "text/vtt", record, 0).pipe(
                                    Effect.orElseSucceed(() => undefined)
                                  )
                                ),
                              { discard: true }
                            )
                          })
                      })
                    }),
                    Effect.succeed(message.namespace === Namespace.media && body.type === "LOAD")
                  )

                  yield* Effect.when(
                    Effect.andThen(
                      Ref.update(playback, (state) =>
                        Playback.$match(state, {
                          Idle: () => Playback.Idle(),
                          Playing: ({ at }) => Playback.Paused({ at }),
                          Paused: ({ at }) => Playback.Paused({ at })
                        })),
                      mediaStatus(requestId)
                    ),
                    Effect.succeed(message.namespace === Namespace.media && body.type === "PAUSE")
                  )

                  yield* Effect.when(
                    Effect.andThen(
                      Ref.update(playback, (state) =>
                        Playback.$match(state, {
                          Idle: () => Playback.Idle(),
                          Playing: ({ at }) => Playback.Playing({ at }),
                          Paused: ({ at }) => Playback.Playing({ at })
                        })),
                      mediaStatus(requestId)
                    ),
                    Effect.succeed(message.namespace === Namespace.media && body.type === "PLAY")
                  )

                  // Seeking is the whole reason HLS exists here, so the device
                  // has to honour it rather than acknowledge it.
                  yield* Effect.when(
                    Effect.andThen(
                      Ref.set(playback, Playback.Playing({ at: body.currentTime ?? 0 })),
                      mediaStatus(requestId)
                    ),
                    Effect.succeed(message.namespace === Namespace.media && body.type === "SEEK")
                  )

                  yield* Effect.when(
                    mediaStatus(requestId),
                    Effect.succeed(
                      message.namespace === Namespace.media && body.type === "GET_STATUS"
                    )
                  )
                })
            })
          })

        // Reassemble frames from the byte stream, exactly as the sender does.
        yield* Effect.forkScoped(
          Stream.runForEach(Stream.fromQueue(messages), (chunk) =>
            Effect.gen(function*() {
              const buffered = Buffer.concat([
                yield* Ref.get(pending),
                Frame.Payload.$match(chunk.payload, {
                  Text: () => Buffer.alloc(0),
                  Binary: ({ value }) => Buffer.from(value)
                })
              ])
              const [frames, rest] = Frame.takeFrames(buffered)
              yield* Ref.set(pending, rest)
              yield* Effect.forEach(frames.slice(0, MEDIA_STATUS_LIMIT), onMessage, {
                discard: true
              })
            }))
        )

        // Hold the scope open for as long as the sender is connected. Without
        // this the generator finishes the moment the handlers are attached, the
        // scope closes, and the reader above is interrupted before a single
        // byte has been read — which looks exactly like a device that accepts
        // connections and then ignores you.
        yield* Effect.callback<void>((resume) => {
          socket.on("close", () => resume(Effect.void))
          socket.on("error", () => resume(Effect.void))
        })
      })

    // The TLS callback is the boundary: it cannot run an Effect, so it only
    // hands the socket to a queue and a forked fiber does the work — the same
    // shape the mDNS datagram callback uses, and the reason neither of them
    // reaches for the runtime from inside library code.
    const connections = yield* Queue.unbounded<tls.TLSSocket>()

    yield* Effect.forkScoped(
      Stream.runForEach(
        Stream.fromQueue(connections),
        (socket) => Effect.forkScoped(Effect.scoped(handle(socket)))
      )
    )

    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.on("secureConnection", (socket) => {
          Queue.offerUnsafe(connections, socket)
        })
        server.listen(0, () => resume(Effect.void))
      }),
      () => Effect.sync(() => server.close())
    )

    const address = server.address()
    const port = Brands.Port.make(
      address !== null && typeof address === "object" ? address.port : 8009
    )

    return {
      port,
      loaded: Ref.get(loaded),
      fetched: Effect.map(Ref.get(fetched), (all) => all.map((item) => item.url)),
      playback: Ref.get(playback),
      awaitFetch: (matching: (url: string) => boolean) =>
        Effect.map(
          Stream.runHead(
            Stream.filter(Stream.fromQueue(arrivals), matching)
          ),
          (found) => found
        )
    } satisfies Device
  })
