// The HTTP endpoints the Cast device pulls from.
//
// The device fetches these; we never push to it. That inversion is the whole
// reason the original VLC bug existed — VLC advertised a link-local IPv6
// address the TV could not route back to.

import { Effect, Ref, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Ffmpeg } from "../Media/Ffmpeg/Service.ts"
import type { Rung } from "../Domain/Rung.ts"
import * as Brands from "../Domain/Brands.ts"
import * as Vtt from "../Media/Vtt/Codec.ts"

export interface SessionState {
  readonly offsetSeconds: Brands.Seconds
  readonly rung: Rung
  readonly cues: Vtt.Cues
}

interface MediaServerOptions {
  readonly file: string
  readonly videoIndex: Brands.StreamIndex
  readonly audioIndex: Brands.StreamIndex | null
  readonly audioBitrate: string
  readonly state: Ref.Ref<SessionState>
  readonly onBytes: (count: number) => Effect.Effect<void>
}

/** The receiver echoes back the offset we put in the URL. */
const queryOffset = (request: HttpServerRequest.HttpServerRequest): Brands.Seconds => {
  const url = new URL(request.originalUrl, "http://localhost")
  return Brands.seconds(Math.max(0, Number(url.searchParams.get("o")) || 0))
}

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
        const offsetSeconds = queryOffset(request) || current.offsetSeconds

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
        const offsetSeconds = queryOffset(request) || current.offsetSeconds
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
