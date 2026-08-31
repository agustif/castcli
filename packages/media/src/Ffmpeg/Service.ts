// ffmpeg / ffprobe integration.
//
// Child processes go through `effect/unstable/process`, so the transcode is a
// scoped resource: when a viewer seeks or the quality controller changes rung,
// closing the scope kills the encoder. That replaces the manual bookkeeping of
// tracking spawned processes in a Set and remembering to SIGKILL them.

import { Context, Effect, Layer, Option, type Scope, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  FilePath,
  Height,
  MediaInfo,
  MediaProbeError,
  MediaStream,
  type StreamIndex,
  TranscodeError
} from "@castcli/domain"

/** Re-exported so callers need only this module. */
export type TranscodeOptions = Args.TranscodeOptions
export type TranscodeFileOptions = Args.TranscodeFileOptions
export type SegmentOptions = Args.SegmentOptions
import * as Vtt from "../Vtt/Codec.ts"
import * as Args from "./Args.ts"

/**
 * The ceiling the Default Media Receiver decodes. Branded, so it can only be
 * compared against another height.
 */
const CAST_MAX_HEIGHT = Height.make(1080)

/** Containers report the codec by name; only this one can be passed through. */
const COPYABLE_CODEC = "h264"

/**
 * 8-bit 4:2:0 only. `yuv420p10le` shares the prefix but is 10-bit, which the
 * receiver cannot decode — hence matching the whole name rather than a prefix.
 */
const COPYABLE_PIXEL_FORMATS = new Set(["yuv420p", "yuvj420p"])

export class Ffmpeg extends Context.Service<Ffmpeg, {
  readonly probe: (file: FilePath) => Effect.Effect<MediaInfo, MediaProbeError>
  readonly extractCues: (
    file: FilePath,
    streamIndex: StreamIndex
  ) => Effect.Effect<Vtt.Cues, MediaProbeError>
  readonly transcode: (
    options: TranscodeOptions
  ) => Effect.Effect<Stream.Stream<Uint8Array, TranscodeError>, TranscodeError, Scope.Scope>
  readonly transcodeFile: (
    options: Args.TranscodeFileOptions
  ) => Effect.Effect<void, TranscodeError>
  readonly segment: (
    options: SegmentOptions
  ) => Effect.Effect<Stream.Stream<Uint8Array, TranscodeError>, TranscodeError, Scope.Scope>
}>()("@castcli/Ffmpeg") {
  static readonly layer = Layer.effect(
    Ffmpeg,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const probe = Effect.fn("Ffmpeg.probe")(function*(file: FilePath) {
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
      file: FilePath,
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

    const transcodeFile = Effect.fn("Ffmpeg.transcodeFile")(function*(options: Args.TranscodeFileOptions) {
      yield* spawner.string(
        ChildProcess.make("ffmpeg", Args.transcodeFile(options))
      ).pipe(Effect.mapError((cause) => new TranscodeError({ cause })))
    })

    /**
     * One HLS segment. Scoped like the transcode, so a receiver that abandons
     * a request — which it does constantly while switching variants — takes
     * the encoder with it rather than leaving it running.
     */
    const segment = Effect.fn("Ffmpeg.segment")(function*(options: Args.SegmentOptions) {
      const handle = yield* spawner.spawn(
        ChildProcess.make("ffmpeg", Args.segment(options))
      ).pipe(Effect.mapError((cause) => new TranscodeError({ cause })))
      return handle.stdout.pipe(
        Stream.mapError((cause) => new TranscodeError({ cause }))
      )
    })

      return { probe, extractCues, transcode, transcodeFile, segment } as const
    })
  )
}

/**
 * Can this video be passed through untouched? Copying is both the best quality
 * and the cheapest CPU, so it is worth asking precisely.
 *
 * Takes the decoded stream rather than three loose strings: every field it
 * needs is optional in ffprobe's output, and `?? ""` defaults turned "the
 * container did not say" into "definitely not copyable" without saying so.
 * Absence is now explicit — an unknown pixel format is not copyable, and the
 * reason is visible in the code.
 */
export const canStreamCopy = (stream: MediaStream): boolean =>
  Option.match(
    Option.all({
      codec: Option.fromNullishOr(stream.codec_name),
      pixelFormat: Option.fromNullishOr(stream.pix_fmt),
      height: Option.fromNullishOr(stream.height)
    }),
    {
      onNone: () => false,
      onSome: ({ codec, height, pixelFormat }) =>
        codec === COPYABLE_CODEC &&
        COPYABLE_PIXEL_FORMATS.has(pixelFormat) &&
        height <= CAST_MAX_HEIGHT
    }
  )
