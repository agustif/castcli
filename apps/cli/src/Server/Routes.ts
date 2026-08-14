// The HTTP endpoints the Cast device pulls from.
//
// The device fetches these; we never push to it. That inversion is the whole
// reason the original VLC bug existed — VLC advertised a link-local IPv6
// address the TV could not route back to.

import { Effect, Option, Ref, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Ffmpeg } from "@castcli/media"
import type { Rung } from "@castcli/domain"
import { Brands, Seconds } from "@castcli/domain"
import { Vtt } from "@castcli/media"

export interface SessionState {
  readonly offsetSeconds: Brands.Seconds
  readonly rung: Rung
  readonly cues: Vtt.Cues
}

interface MediaServerOptions {
  readonly file: Brands.FilePath
  readonly videoIndex: Brands.StreamIndex
  readonly audioIndex: Option.Option<Brands.StreamIndex>
  readonly audioBitrate: Brands.AudioBitrate
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

// The requirement type is inferred: v4 tracks each handler's error and service
// requirements in the Layer's context, so pinning it by hand fights the router.
export const routes = (options: MediaServerOptions) =>
  HttpRouter.addAll([
    HttpRouter.route(
      "GET",
      "/stream",
      Effect.fn("MediaServer.stream")(function*(request: HttpServerRequest.HttpServerRequest) {
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

        // Counting bytes as they pass gives the quality controller its
        // throughput signal, measured where backpressure actually applies.
        const counted = source.pipe(
          Stream.tap((chunk) => options.onBytes(chunk.length))
        )

        // A live pipe has no meaningful byte ranges: always answer 200 and let
        // the receiver read to EOF. Seeking restarts ffmpeg at a new offset.
        return HttpServerResponse.stream(counted, {
          contentType: "video/mp4",
          headers: {
            "accept-ranges": "none",
            "cache-control": "no-store"
          }
        })
      })
    ),

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
    )
  ])
