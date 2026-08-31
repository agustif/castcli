// The HTTP endpoints the Cast device pulls from.
//
// The device fetches these; we never push to it. That inversion is the whole
// reason the original VLC bug existed — VLC advertised a link-local IPv6
// address the TV could not route back to.
//
// Two presentations of the same film are served side by side, because they fail
// in different ways and neither is strictly better:
//
//   * **progressive** (`/stream`) — a finished faststart MP4 with byte ranges.
//     ffmpeg writes a seekable file (`+faststart`), we cache the bytes, and
//     Range probes get 206 with Content-Length rather than a live pipe.
//   * **HLS** (`/master.m3u8`) — a VOD presentation, one variant per rung, every
//     segment addressable. The receiver chooses the quality and does its own
//     seeking, so neither costs a restart.
//
// Serving both costs almost nothing: the segments do not exist until they are
// requested, so an unused HLS surface encodes nothing at all.

import { Console, Effect, Match, Option, Ref, Schema, Stream } from "effect"
import { FileSystem } from "effect/FileSystem"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Ffmpeg, FfmpegArgs, Hls } from "@castcli/media"
import type { Rung } from "@castcli/domain"
import { Brands, Seconds } from "@castcli/domain"
import { Srt, Vtt } from "@castcli/media"
import * as os from "node:os"
import * as path from "node:path"

export interface SessionState {
  readonly offsetSeconds: Brands.Seconds
  readonly rung: Rung
  readonly cues: Vtt.Cues
}

interface MediaServerOptions {
  readonly file: Brands.FilePath
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
type ByteRange =
  | { readonly _tag: "All" }
  | { readonly _tag: "Slice"; readonly start: number; readonly end: number }
  | { readonly _tag: "Unsatisfiable" }

/**
 * RFC 7233 `bytes=` ranges: `START-END`, `START-`, or `-SUFFIX`.
 * Anything else, including a range past EOF, is unsatisfiable (416).
 */
const parseByteRange = (header: string, total: number): ByteRange => {
  const raw = String(header).trim()
  return raw.length === 0
    ? { _tag: "All" }
    : Option.match(Option.fromNullishOr(/^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(raw)), {
      onNone: (): ByteRange => ({ _tag: "Unsatisfiable" }),
      onSome: (match): ByteRange => {
        const suffixText = match[3]
        const startText = match[1]
        const endText = match[2]
        return suffixText !== undefined
          ? Number(suffixText) === 0 || total === 0
            ? { _tag: "Unsatisfiable" }
            : {
              _tag: "Slice",
              start: Math.max(0, total - Number(suffixText)),
              end: total - 1
            }
          : (() => {
            const start = Number(startText)
            const end = endText !== undefined && endText.length > 0 ? Number(endText) : total - 1
            return Number.isFinite(start) && Number.isFinite(end) && total > 0 && start < total &&
                start <= end
              ? { _tag: "Slice", start, end: Math.min(end, total - 1) }
              : { _tag: "Unsatisfiable" }
          })()
      }
    })
}

const streamCors = {
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "accept-ranges": "bytes"
} as const

export const routes = (options: MediaServerOptions) => {
  const progressiveCache = new Map<string, Uint8Array>()

  const loadProgressive = Effect.fn("MediaServer.progressiveMp4")(function*(
    offsetSeconds: Brands.Seconds,
    rung: Rung
  ) {
    const key = `${options.file}|${offsetSeconds}|${rung.height}`
    return yield* Option.match(Option.fromNullishOr(progressiveCache.get(key)), {
      onSome: (bytes) => Effect.succeed(bytes),
      onNone: () =>
        Effect.gen(function*() {
          const ffmpeg = yield* Ffmpeg
          const fs = yield* FileSystem
          const outPath = path.join(
            os.tmpdir(),
            `castcli-stream-${globalThis.crypto.randomUUID()}.mp4`
          )
          const transcodeOptions = {
            file: options.file,
            offsetSeconds,
            videoIndex: options.videoIndex,
            audioIndex: options.audioIndex,
            rung,
            audioBitrate: options.audioBitrate,
            outPath
          }
          yield* Console.log(`ffmpeg transcodeFile ${FfmpegArgs.transcodeFile(transcodeOptions).join(" ")}`)
          yield* ffmpeg.transcodeFile(transcodeOptions).pipe(
            Effect.tapError((error) => Console.log(`transcodeFile failed ${error}`))
          )
          const bytes = yield* fs.readFile(outPath)
          yield* fs.remove(outPath).pipe(Effect.ignore)
          progressiveCache.set(key, bytes)
          yield* options.onBytes(bytes.byteLength)
          yield* Console.log(`transcodeFile done bytes=${bytes.byteLength} key=${key}`)
          return bytes
        })
    })
  })

  const handleStream = Effect.fn("MediaServer.stream")(function*(
    request: HttpServerRequest.HttpServerRequest
  ) {
    const current = yield* Ref.get(options.state)
    const offsetSeconds = Option.getOrElse(queryOffset(request), () => current.offsetSeconds)
    const remote = Option.getOrElse(request.remoteAddress, () => "?")
    const rangeHeader = String(request.headers["range"] ?? "")

    yield* Effect.logInfo(
      `stream requested from ${offsetSeconds}s at ${current.rung.height}p`
    )
    yield* Console.log(
      `stream requested from ${offsetSeconds}s at ${current.rung.height}p from ${remote} url=${request.originalUrl}`
    )

    const bytes = yield* loadProgressive(offsetSeconds, current.rung)
    const total = bytes.byteLength
    const range = parseByteRange(rangeHeader, total)
    const head = request.method === "HEAD"

    const response = Match.value(range).pipe(
      Match.when({ _tag: "All" }, () =>
        head
          ? HttpServerResponse.empty({
            status: 200,
            headers: {
              ...streamCors,
              "content-type": "video/mp4",
              "content-length": String(total)
            }
          })
          : HttpServerResponse.uint8Array(bytes, {
            status: 200,
            contentType: "video/mp4",
            headers: streamCors
          })),
      Match.when({ _tag: "Slice" }, ({ start, end }) => {
        const slice = bytes.subarray(start, end + 1)
        const headers = {
          ...streamCors,
          "content-range": `bytes ${start}-${end}/${total}`
        }
        return head
          ? HttpServerResponse.empty({
            status: 206,
            headers: {
              ...headers,
              "content-type": "video/mp4",
              "content-length": String(slice.byteLength)
            }
          })
          : HttpServerResponse.uint8Array(slice, {
            status: 206,
            contentType: "video/mp4",
            headers
          })
      }),
      Match.when({ _tag: "Unsatisfiable" }, () =>
        HttpServerResponse.empty({
          status: 416,
          headers: {
            ...streamCors,
            "content-type": "video/mp4",
            "content-range": `bytes */${total}`
          }
        })),
      Match.exhaustive
    )

    yield* Console.log(
      `stream range=${rangeHeader.length > 0 ? rangeHeader : "-"} bytes=${total} status=${response.status} method=${request.method} from ${remote}`
    )
    return response
  })

  return HttpRouter.addAll([
    // --- progressive ---------------------------------------------------------

    HttpRouter.route("GET", "/stream", handleStream),
    HttpRouter.route("HEAD", "/stream", handleStream),

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
