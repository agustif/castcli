// ffmpeg / ffprobe integration.
//
// Child processes go through `effect/unstable/process`, so the transcode is a
// scoped resource: when a viewer seeks or the quality controller changes rung,
// closing the scope kills the encoder. That replaces the manual bookkeeping of
// tracking spawned processes in a Set and remembering to SIGKILL them.

import { Context, Effect, Layer, type Scope, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { MediaInfo } from "../../Domain/Media.ts"
import { MediaProbeError, TranscodeError } from "../../Domain/Errors.ts"
import type { StreamIndex } from "../../Domain/Brands.ts"

/** Re-exported so callers need only this module. */
export type TranscodeOptions = Args.TranscodeOptions
import * as Vtt from "../Vtt/Codec.ts"
import * as Args from "./Args.ts"

/** Cast receivers decode H.264 up to 1080p; anything else has to be re-encoded. */
const CAST_MAX_HEIGHT = 1080

export class Ffmpeg extends Context.Service<Ffmpeg, {
  readonly probe: (file: string) => Effect.Effect<MediaInfo, MediaProbeError>
  readonly extractCues: (
    file: string,
    streamIndex: StreamIndex
  ) => Effect.Effect<Vtt.Cues, MediaProbeError>
  readonly transcode: (
    options: TranscodeOptions
  ) => Effect.Effect<Stream.Stream<Uint8Array, TranscodeError>, TranscodeError, Scope.Scope>
}>()("@castcli/Ffmpeg") {
  static readonly layer = Layer.effect(
    Ffmpeg,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const probe = Effect.fn("Ffmpeg.probe")(function*(file: string) {
      const json = yield* spawner.string(
        ChildProcess.make("ffprobe", Args.probe(file))
      ).pipe(
        Effect.mapError((cause) => new MediaProbeError({ path: file, cause }))
      )

      // Decoded through Schema rather than JSON.parse, so a surprising ffprobe
      // payload fails here with a useful message instead of somewhere later.
      return yield* Schema.decodeEffect(Schema.fromJsonString(MediaInfo))(json).pipe(
        Effect.mapError((issue) => new MediaProbeError({ path: file, cause: issue }))
      )
    })

    /**
     * Extract one subtitle track as cues. Deliberately collected in full before
     * anything is served: a Cast receiver handed a slowly-arriving text track
     * renders it progressively, stacking cues on screen instead of replacing
     * them.
     */
    const extractCues = Effect.fn("Ffmpeg.extractCues")(function*(
      file: string,
      streamIndex: StreamIndex
    ) {
      const vtt = yield* spawner.string(
        ChildProcess.make("ffmpeg", Args.extractSubtitles(file, streamIndex))
      ).pipe(
        Effect.mapError((cause) => new MediaProbeError({ path: file, cause }))
      )
      return yield* Vtt.decode(vtt).pipe(
        Effect.mapError((issue) => new MediaProbeError({ path: file, cause: issue }))
      )
    })

    /**
     * Remux (and if necessary re-encode) into fragmented MP4 on stdout.
     *
     * Scoped: the encoder dies with the scope, so a seek or a rung change is
     * just "close the old scope, open a new one".
     */
    const transcode = Effect.fn("Ffmpeg.transcode")(function*(options: TranscodeOptions) {
      const handle = yield* spawner.spawn(
        ChildProcess.make("ffmpeg", Args.transcode(options))
      ).pipe(Effect.mapError((cause) => new TranscodeError({ cause })))
      // Scoped: closing the scope kills the encoder, so a seek or a rung change
      // is just "close the old scope, open a new one".
      return handle.stdout.pipe(
        Stream.mapError((cause) => new TranscodeError({ cause }))
      )
    })

      return { probe, extractCues, transcode } as const
    })
  )
}

/** Can this video be passed through untouched? Copying is best quality and free. */
export const canStreamCopy = (
  codec: string | undefined,
  pixelFormat: string | undefined,
  height: number | undefined
): boolean =>
  codec === "h264" &&
  (pixelFormat ?? "").startsWith("yuv420p") &&
  !(pixelFormat ?? "").includes("10") &&
  (height ?? 0) <= CAST_MAX_HEIGHT
