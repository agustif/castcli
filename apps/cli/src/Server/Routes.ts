// The HTTP endpoints the Cast device and AirPlay pull from.
//
// The device fetches these; we never push to it. That inversion is the whole
// reason the original VLC bug existed — VLC advertised a link-local IPv6
// address the TV could not route back to.
//
// Three presentations of the same film are served side by side:
//
//   * **progressive** (`/stream`) — live fragmented MP4 pipe for Cast.
//     ffmpeg outputs frag_keyframe+empty_moov+default_base_moof on stdout,
//     no byte ranges (Accept-Ranges: none), so Cast progressive LOAD works.
//   * **VOD** (`/vod.mp4`) — finished faststart MP4 for AirPlay URL play.
//     ffmpeg writes a seekable file (+faststart), cached, with byte ranges
//     and CORS for AirPlay seek support.
//   * **HLS** (`/master.m3u8`) — VOD presentation, one variant per rung, every
//     segment addressable. The receiver chooses quality and seeks itself.
//
// Cast progressive (--progressive) uses /stream. Cast default uses HLS.
// AirPlay uses /vod.mp4.

import { Console, Effect, Match, Option, Ref, Schema, Stream } from "effect"
import { FileSystem } from "effect/FileSystem"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Ffmpeg, Hls } from "@castcli/media"
import type { Rung } from "@castcli/domain"
import { Brands, Seconds } from "@castcli/domain"
import { Srt, Vtt } from "@castcli/media"

export interface SessionState {
  readonly offsetSeconds: Brands.Seconds
  readonly rung: Rung
  readonly cues: Vtt.Cues
}

interface MediaServerOptions {
  readonly file: Brands.FilePath
  readonly vodCachePath: Brands.FilePath
  readonly durationSeconds: Brands.Seconds
  readonly videoIndex: Brands.StreamIndex
  readonly audioIndex: Option.Option<Brands.StreamIndex>
  readonly audioBitrate: Brands.AudioBitrate
  /** Peak audio rate, which the master playlist must include in BANDWIDTH. */
  readonly audioBitsPerSecond: number
  /** One HLS variant per rung, in the order the master playlist advertises. */
  readonly ladder: ReadonlyArray<Rung>
  readonly state: Ref.Ref<SessionState>
  readonly onBytes: (count: number) => Effect.Effect<void>
}

/**
 * The offset the receiver echoes back from the URL we handed it.
 *
 * Decoded through a schema rather than parsed by hand. The previous version
 * used `Number(...) || 0` and then `|| current.offsetSeconds` at the call site,
 * which made a legitimate `?o=0` — seek to the very start — indistinguishable
 * from an absent parameter, so it silently resumed from wherever the session
 * happened to be.
 */
const OffsetQuery = Schema.Struct({
  o: Schema.optional(Schema.FiniteFromString.pipe(Schema.decodeTo(Seconds)))
})

/**
 * Takes the URL rather than the request: the decision this makes is entirely a
 * function of the query string, and threading a whole server request through it
 * put the one piece of parsing that has already been wrong once out of reach of
 * a test.
 */
export const offsetFromUrl = (url: string): Option.Option<Brands.Seconds> =>
  Option.flatMap(
    Schema.decodeUnknownOption(OffsetQuery)(
      Object.fromEntries(
        // An empty `?o=` is no parameter at all. Without this it decodes to
        // zero, because `Number("")` is zero — which is exactly the
        // absent-versus-start confusion this parsing exists to avoid.
        globalThis.Array.from(new URL(url, "http://localhost").searchParams)
          .filter(([, value]) => value.length > 0)
      )
    ),
    (query) => Option.fromNullishOr(query.o)
  )

const queryOffset = (
  request: HttpServerRequest.HttpServerRequest
): Option.Option<Brands.Seconds> => offsetFromUrl(request.originalUrl)

/**
 * A path segment that has to be a whole number inside a known range.
 *
 * Range-checked rather than merely parsed: a variant or segment we never
 * advertised is a request we did not invite, and answering it by clamping would
 * hand back the wrong part of the film with a 200.
 */
const indexIn = (count: number) =>
  Schema.FiniteFromString.pipe(
    Schema.decodeTo(
      Schema.Int.pipe(
        Schema.check(Schema.isBetween({ minimum: 0, maximum: Math.max(0, count - 1) }))
      )
    )
  )

const playlistHeaders = {
  // Arithmetic over a file that is not changing, but a receiver holding these
  // across sessions would keep a stale variant list.
  "cache-control": "no-store",
  "access-control-allow-origin": "*"
} as const

const mpegTsPid = (packet: Uint8Array): number =>
  (((packet[1] ?? 0) & 0x1f) << 8) | (packet[2] ?? 0)

const notFound = HttpServerResponse.empty({ status: 404 })

// The requirement type is inferred: v4 tracks each handler's error and service
// requirements in the Layer's context, so pinning it by hand fights the router.
export const routes = (options: MediaServerOptions) => {

  const handleStream = Effect.fn("MediaServer.stream")(function*(
    request: HttpServerRequest.HttpServerRequest
  ) {
    const ffmpeg = yield* Ffmpeg
    const current = yield* Ref.get(options.state)
    const offsetSeconds = Option.getOrElse(queryOffset(request), () => current.offsetSeconds)

    yield* Effect.logInfo(
      `stream requested from ${offsetSeconds}s at ${current.rung.height}p`
    )

    const source = yield* ffmpeg.transcode({
      file: options.file,
      offsetSeconds,
      videoIndex: options.videoIndex,
      audioIndex: options.audioIndex,
      rung: current.rung,
      audioBitrate: options.audioBitrate
    })

    const counted = source.pipe(
      Stream.tap((chunk) => options.onBytes(chunk.length))
    )

    return HttpServerResponse.stream(counted, {
      contentType: "video/mp4",
      headers: {
        "accept-ranges": "none",
        "cache-control": "no-store"
      }
    })
  })

  return HttpRouter.addAll([
    // --- progressive ---------------------------------------------------------

    HttpRouter.route("GET", "/stream", handleStream),

    HttpRouter.route(
      "GET",
      "/vod.mp4",
      Effect.fn("MediaServer.vod")(function*(request: HttpServerRequest.HttpServerRequest) {
        const fs = yield* FileSystem
        const ffmpeg = yield* Ffmpeg

        const vodExists = yield* fs.exists(options.vodCachePath)

        yield* Effect.when(
          Effect.gen(function*() {
            yield* Effect.logInfo("creating VOD cache file with faststart")
            const current = yield* Ref.get(options.state)
            yield* ffmpeg.transcodeFile({
              file: options.file,
              offsetSeconds: Seconds.make(0),
              videoIndex: options.videoIndex,
              audioIndex: options.audioIndex,
              rung: current.rung,
              audioBitrate: options.audioBitrate,
              outPath: options.vodCachePath
            })
          }),
          Effect.succeed(!vodExists)
        )

        const stat = yield* fs.stat(options.vodCachePath)
        const fileSize = Number(stat.size)

        const rangeHeader = request.headers["range"]

        return yield* Option.match(Option.fromNullishOr(rangeHeader), {
          onNone: () =>
            Effect.succeed(
              HttpServerResponse.stream(fs.stream(options.vodCachePath), {
                contentType: "video/mp4",
                headers: {
                  "accept-ranges": "bytes",
                  "content-length": String(fileSize),
                  "access-control-allow-origin": "*",
                  "cache-control": "public, max-age=3600"
                }
              })
            ),
          onSome: (range) =>
            Effect.gen(function*() {
              const rangeMatch = /bytes=(\d+)-(\d*)/.exec(range)

              return yield* Option.match(Option.fromNullishOr(rangeMatch), {
                onNone: () => Effect.succeed(HttpServerResponse.empty({ status: 416 })),
                onSome: (match) =>
                  Effect.gen(function*() {
                    const start = Number(match[1])
                    const end =
                      match[2] !== undefined && match[2] !== "" ? Number(match[2]) : fileSize - 1

                    const isInvalidRange = start >= fileSize || end >= fileSize

                    return yield* Match.value(isInvalidRange).pipe(
                      Match.when(true, () => Effect.succeed(HttpServerResponse.empty({ status: 416 }))),
                      Match.when(false, () =>
                        Effect.succeed(
                          HttpServerResponse.stream(
                            fs.stream(options.vodCachePath, {
                              offset: start,
                              bytesToRead: end - start + 1
                            }),
                            {
                              status: 206,
                              contentType: "video/mp4",
                              headers: {
                                "accept-ranges": "bytes",
                                "content-range": `bytes ${start}-${end}/${fileSize}`,
                                "content-length": String(end - start + 1),
                                "access-control-allow-origin": "*",
                                "cache-control": "public, max-age=3600"
                              }
                            }
                          )
                        )),
                      Match.exhaustive
                    )
                  })
              })
            })
        })
      })
    ),

    // --- HLS -----------------------------------------------------------------

    HttpRouter.route(
      "GET",
      "/master.m3u8",
      Effect.fn("MediaServer.master")(function*(request: HttpServerRequest.HttpServerRequest) {
        yield* Effect.logInfo(
          `hls master requested: ${options.ladder.length} variants, ` +
            `${Hls.segmentCount(options.durationSeconds)} segments each`
        )
        yield* Console.log(
          `hls master requested from ${Option.getOrElse(request.remoteAddress, () => "?")} url=${request.originalUrl}`
        )
        return HttpServerResponse.text(
          Hls.master(options.ladder, options.audioBitsPerSecond, (variant) => `/v${variant}.m3u8`),
          { contentType: Hls.CONTENT_TYPE, headers: playlistHeaders }
        )
      })
    ),

    HttpRouter.route(
      "GET",
      "/v:variant.m3u8",
      Effect.fn("MediaServer.variant")(function*(request: HttpServerRequest.HttpServerRequest) {
        const params = yield* HttpRouter.params
        const variant = Schema.decodeUnknownOption(indexIn(options.ladder.length))(
          params["variant"]
        )

        yield* Console.log(
          `hls variant requested from ${Option.getOrElse(request.remoteAddress, () => "?")} variant=${params["variant"] ?? "?"}`
        )
        return Option.match(variant, {
          onNone: () => notFound,
          onSome: (index) =>
            HttpServerResponse.text(
              Hls.media(options.durationSeconds, (segment) => `/v${index}/${segment}.ts`),
              { contentType: Hls.CONTENT_TYPE, headers: playlistHeaders }
            )
        })
      })
    ),

    HttpRouter.route(
      "GET",
      "/v:variant/:segment.ts",
      Effect.fn("MediaServer.segment")(function*(request: HttpServerRequest.HttpServerRequest) {
        const ffmpeg = yield* Ffmpeg
        const params = yield* HttpRouter.params
        yield* Console.log(
          `hls segment requested from ${Option.getOrElse(request.remoteAddress, () => "?")} v=${params["variant"] ?? "?"} seg=${params["segment"] ?? "?"}`
        )

        const wanted = Option.all({
          variant: Schema.decodeUnknownOption(indexIn(options.ladder.length))(params["variant"]),
          segment: Schema.decodeUnknownOption(
            indexIn(Hls.segmentCount(options.durationSeconds))
          )(params["segment"])
        })

        return yield* Option.match(wanted, {
          onNone: () => Effect.succeed(notFound),
          onSome: ({ segment, variant }) =>
            Option.match(Option.fromNullishOr(options.ladder[variant]), {
              onNone: () => Effect.succeed(notFound),
              onSome: (rung) =>
                Effect.gen(function*() {
                  const source = yield* ffmpeg.segment({
                    file: options.file,
                    startSeconds: Hls.segmentStart(segment),
                    durationSeconds: Hls.segmentLength(segment, options.durationSeconds),
                    videoIndex: options.videoIndex,
                    audioIndex: options.audioIndex,
                    rung,
                    audioBitrate: options.audioBitrate
                  })

                  const chunks = yield* Stream.runCollect(
                    source.pipe(Stream.tap((chunk) => options.onBytes(chunk.length)))
                  )

                  const totalLength = chunks.reduce((sum: number, chunk) => sum + chunk.length, 0)
                  const buffer = new Uint8Array(totalLength)
                  let offset = 0
                  for (const chunk of chunks) {
                    buffer.set(chunk, offset)
                    offset += chunk.length
                  }

                  // ffmpeg emits SDT (PID 0x11) before PAT. Cheap Cast receivers
                  // probe the first packet and LOAD_FAILED unless it is PAT.
                  const TS = 188
                  const packetCount = Math.floor(buffer.length / TS)
                  const packets = globalThis.Array.from({ length: packetCount }, (_, n) =>
                    buffer.subarray(n * TS, (n + 1) * TS)
                  )
                  const kept = packets.filter((packet) => mpegTsPid(packet) !== 0x11)
                  const patFirst = new Uint8Array(kept.reduce((sum, packet) => sum + packet.length, 0))
                  kept.reduce((at, packet) => {
                    patFirst.set(packet, at)
                    return at + packet.length
                  }, 0)

                  return HttpServerResponse.uint8Array(patFirst, {
                    contentType: Hls.SEGMENT_CONTENT_TYPE,
                    headers: playlistHeaders
                  })
                })
            })
        })
      })
    ),

    // --- subtitles, shared by both -------------------------------------------

    HttpRouter.route(
      "GET",
      "/subs.vtt",
      Effect.fn("MediaServer.subtitles")(function*(
        request: HttpServerRequest.HttpServerRequest
      ) {
        const current = yield* Ref.get(options.state)
        const offsetSeconds = Option.getOrElse(queryOffset(request), () => current.offsetSeconds)
        const body = yield* Vtt.encode(Vtt.cutFrom(current.cues, offsetSeconds))
        // Served complete and in one shot. A slow chunked reply makes the
        // receiver parse the track progressively, stacking cues on screen
        // instead of replacing them.
        return HttpServerResponse.text(body, {
          contentType: "text/vtt; charset=utf-8",
          headers: {
            "access-control-allow-origin": "*",
            "cache-control": "no-store"
          }
        })
      })
    ),

    HttpRouter.route(
      "GET",
      "/subs.srt",
      Effect.fn("MediaServer.subtitlesSrt")(function*(
        request: HttpServerRequest.HttpServerRequest
      ) {
        // The same cues in the other format, for televisions that will not read
        // WebVTT. A DLNA renderer is told its subtitle track is `text/srt` —
        // that is what the `sec:CaptionInfoEx` element Samsung and LG read means
        // — and handing it WebVTT at that URL produces a file it fetches, fails
        // to parse, and says nothing about.
        const current = yield* Ref.get(options.state)
        const offsetSeconds = Option.getOrElse(queryOffset(request), () => current.offsetSeconds)
        return HttpServerResponse.text(
          Srt.encode(Vtt.cutFrom(current.cues, offsetSeconds)),
          {
            contentType: "application/x-subrip",
            headers: {
              "access-control-allow-origin": "*",
              "cache-control": "no-store"
            }
          }
        )
      })
    )
  ])
}
