// ffmpeg invocations as typed values.
//
// The previous version built a flat `Array<string>` by hand. That array is a
// wire protocol to another program, and it had every failure mode of stringly
// typed code: a typo in `-movflags` is silently accepted by the array and only
// fails at runtime; positional rules (input seeking must precede `-i`) are
// invisible; and nothing stops a bitrate being passed where a codec belongs.
//
// Here each option is a variant of a tagged union with a `render` function, and
// the codec, muxer and flag names are closed literal sets. A typo is a compile
// error, `Match.exhaustive` forces every option to be renderable, and the
// ordering rule is expressed once, in `build`, instead of being implied by the
// order of `push` calls.

import { Data, Match, Option, Schema } from "effect"
import type { AudioBitrate, Bitrate, FilePath, Seconds, StreamIndex } from "@castcli/domain"
import { Rung } from "@castcli/domain"

// --- closed vocabularies -----------------------------------------------------

const VideoCodec = Schema.Literals(["copy", "h264_videotoolbox", "libx264"])
type VideoCodec = typeof VideoCodec.Type

/** AAC-LC is the one audio codec every Cast receiver accepts. */
const AudioCodec = Schema.Literals(["copy", "aac", "libmp3lame"])
type AudioCodec = typeof AudioCodec.Type

const Muxer = Schema.Literals(["mp4", "matroska", "webvtt", "mpegts"])
type Muxer = typeof Muxer.Type

const LogLevel = Schema.Literals(["quiet", "error", "warning", "info", "debug"])
type LogLevel = typeof LogLevel.Type

/**
 * `frag_keyframe+empty_moov+default_base_moof` is what makes an MP4 playable
 * before it is complete — without it the receiver waits for a moov atom that a
 * live pipe never produces.
 */
const MovFlag = Schema.Literals([
  "frag_keyframe",
  "empty_moov",
  "default_base_moof",
  "faststart"
])
type MovFlag = typeof MovFlag.Type

const H264Profile = Schema.Literals(["baseline", "main", "high"])
type H264Profile = typeof H264Profile.Type

const MpegtsFlag = Schema.Literals(["initial_discontinuity", "resend_headers"])
type MpegtsFlag = typeof MpegtsFlag.Type

// --- options -----------------------------------------------------------------

export type Arg = Data.TaggedEnum<{
  readonly Banner: { readonly hidden: boolean }
  readonly Log: { readonly level: LogLevel }
  readonly NoStdin: {}
  /** Overwrite the output file without prompting. Needed by transcodeFile. */
  readonly Overwrite: {}
  /** Input seeking. Must come before `Input` to be fast and to rebase timestamps. */
  readonly SeekInput: { readonly at: Seconds }
  readonly Input: { readonly path: FilePath }
  readonly Map: { readonly stream: StreamIndex }
  readonly Video: { readonly codec: VideoCodec }
  readonly Audio: { readonly codec: AudioCodec }
  readonly VideoProfile: { readonly profile: H264Profile }
  readonly VideoBitrate: { readonly bitrate: Bitrate }
  readonly MaxRate: { readonly bitrate: Bitrate }
  readonly BufSize: { readonly bytes: number }
  readonly Gop: { readonly frames: number }
  readonly ScaleHeight: { readonly height: number }
  readonly AudioChannels: { readonly count: number }
  readonly AudioBitrate: { readonly rate: AudioBitrate }
  readonly Format: { readonly muxer: Muxer }
  /** Bound the output to a duration — one HLS segment's worth. */
  readonly Duration: { readonly seconds: number }
  /**
   * Shift output timestamps so a segment carries the presentation times it has
   * in the film. Without it every segment starts at zero and a player that
   * concatenates them sees time run backwards at each boundary.
   */
  readonly TimestampOffset: { readonly seconds: number }
  /** Force a keyframe at the start, so a segment can be decoded on its own. */
  readonly ForceKeyFrames: { readonly expression: string }
  readonly MuxDelay: { readonly seconds: number }
  readonly MpegtsFlags: { readonly flags: ReadonlyArray<MpegtsFlag> }
  readonly MovFlags: { readonly flags: ReadonlyArray<MovFlag> }
  readonly Output: { readonly target: string }
}>

export const Arg = Data.taggedEnum<Arg>()

const render: (arg: Arg) => ReadonlyArray<string> = Match.type<Arg>().pipe(
  Match.tag("Banner", ({ hidden }) => hidden ? ["-hide_banner"] : []),
  Match.tag("Log", ({ level }) => ["-loglevel", level]),
  Match.tag("NoStdin", () => ["-nostdin"]),
  Match.tag("Overwrite", () => ["-y"]),
  Match.tag("SeekInput", ({ at }) => at > 0 ? ["-ss", String(at)] : []),
  Match.tag("Input", ({ path }) => ["-i", path]),
  Match.tag("Map", ({ stream }) => ["-map", `0:${stream}`]),
  Match.tag("Video", ({ codec }) => ["-c:v", codec]),
  Match.tag("Audio", ({ codec }) => ["-c:a", codec]),
  Match.tag("VideoProfile", ({ profile }) => ["-profile:v", profile]),
  Match.tag("VideoBitrate", ({ bitrate }) => ["-b:v", String(bitrate)]),
  Match.tag("MaxRate", ({ bitrate }) => ["-maxrate", String(bitrate)]),
  Match.tag("BufSize", ({ bytes }) => ["-bufsize", String(bytes)]),
  Match.tag("Gop", ({ frames }) => ["-g", String(frames)]),
  Match.tag("ScaleHeight", ({ height }) => ["-vf", `scale=-2:'min(${height},ih)'`]),
  Match.tag("AudioChannels", ({ count }) => ["-ac", String(count)]),
  Match.tag("AudioBitrate", ({ rate }) => ["-b:a", rate]),
  Match.tag("Format", ({ muxer }) => ["-f", muxer])
).pipe(
  // Split only because `pipe` takes at most twenty arguments; the two halves
  // are one exhaustive match.
  Match.tag("Duration", ({ seconds }) => ["-t", String(seconds)]),
  Match.tag("TimestampOffset", ({ seconds }) => ["-output_ts_offset", String(seconds)]),
  Match.tag("ForceKeyFrames", ({ expression }) => ["-force_key_frames", expression]),
  Match.tag("MuxDelay", ({ seconds }) => ["-muxdelay", String(seconds), "-muxpreload", String(seconds)]),
  Match.tag("MpegtsFlags", ({ flags }) => flags.length > 0 ? ["-mpegts_flags", flags.join("+")] : []),
  Match.tag("MovFlags", ({ flags }) => ["-movflags", flags.join("+")]),
  Match.tag("Output", ({ target }) => [target]),
  Match.exhaustive
)

const renderAll = (args: ReadonlyArray<Arg>): ReadonlyArray<string> =>
  args.flatMap(render)

// --- invocations -------------------------------------------------------------

export interface TranscodeOptions {
  readonly file: FilePath
  readonly offsetSeconds: Seconds
  readonly videoIndex: StreamIndex
  readonly audioIndex: Option.Option<StreamIndex>
  readonly rung: Rung
  readonly audioBitrate: AudioBitrate
}

/** Video options for a rung. Exhaustive: a new rung kind will not compile. */
const videoFor: (rung: Rung) => ReadonlyArray<Arg> = Match.type<Rung>().pipe(
  Match.tag("Copy", () => [Arg.Video({ codec: "copy" })]),
  // VideoToolbox keeps this comfortably realtime on Apple silicon, so the
  // ceiling stays the network rather than the CPU.
  Match.tag("Encode", ({ bitrate, height }) => [
    Arg.Video({ codec: "h264_videotoolbox" }),
    Arg.VideoProfile({ profile: "high" }),
    Arg.VideoBitrate({ bitrate }),
    Arg.MaxRate({ bitrate }),
    Arg.BufSize({ bytes: bitrate * 2 }),
    Arg.Gop({ frames: 48 }),
    Arg.ScaleHeight({ height })
  ]),
  Match.exhaustive
)

const preamble: ReadonlyArray<Arg> = [
  Arg.Banner({ hidden: true }),
  Arg.Log({ level: "error" }),
  Arg.NoStdin()
]

/**
 * Remux (and if necessary re-encode) into fragmented MP4 on stdout.
 *
 * Matroska is not a supported Cast container whatever the source was, and a
 * plain MP4 cannot start playing before it is complete — hence the fragment
 * flags.
 */
export const transcode = (options: TranscodeOptions): ReadonlyArray<string> =>
  renderAll([
    ...preamble,
    // Before `Input`, deliberately: input seeking is fast and rebases output
    // timestamps to zero, which is what lets the receiver treat every restart
    // as a fresh stream.
    Arg.SeekInput({ at: options.offsetSeconds }),
    Arg.Input({ path: options.file }),
    Arg.Map({ stream: options.videoIndex }),
    ...Option.match(options.audioIndex, {
      onNone: () => [],
      onSome: (stream) => [Arg.Map({ stream })]
    }),
    ...videoFor(options.rung),
    Arg.Audio({ codec: "aac" }),
    Arg.AudioChannels({ count: 2 }),
    Arg.AudioBitrate({ rate: options.audioBitrate }),
    Arg.Format({ muxer: "mp4" }),
    Arg.MovFlags({ flags: ["frag_keyframe", "empty_moov", "default_base_moof"] }),
    Arg.Output({ target: "pipe:1" })
  ])

export interface TranscodeFileOptions extends TranscodeOptions {
  readonly outPath: string
}

/**
 * Finished MP4 on disk with the moov atom first. AirPlay URL playback (and any
 * client that sends Range) cannot play a live pipe: there is no Content-Length
 * and no moov until EOF. `+faststart` requires a seekable file, not stdout.
 */
export const transcodeFile = (options: TranscodeFileOptions): ReadonlyArray<string> =>
  renderAll([
    ...preamble,
    Arg.Overwrite(),
    Arg.SeekInput({ at: options.offsetSeconds }),
    Arg.Input({ path: options.file }),
    Arg.Map({ stream: options.videoIndex }),
    ...Option.match(options.audioIndex, {
      onNone: () => [],
      onSome: (stream) => [Arg.Map({ stream })]
    }),
    ...videoFor(options.rung),
    Arg.Audio({ codec: "aac" }),
    Arg.AudioChannels({ count: 2 }),
    Arg.AudioBitrate({ rate: options.audioBitrate }),
    Arg.Format({ muxer: "mp4" }),
    Arg.MovFlags({ flags: ["faststart"] }),
    Arg.Output({ target: options.outPath })
  ])

export interface SegmentOptions {
  readonly file: FilePath
  readonly startSeconds: Seconds
  readonly durationSeconds: number
  readonly videoIndex: StreamIndex
  readonly audioIndex: Option.Option<StreamIndex>
  readonly rung: Rung
  readonly audioBitrate: AudioBitrate
}

/**
 * One HLS segment on stdout, as MPEG-TS.
 *
 * Each segment is an independent ffmpeg run seeking straight to its own start,
 * which is what makes the playlist's thousand segments cost nothing until they
 * are asked for. Three details make the pieces fit back together:
 *
 *   * the seek is *before* `-i`, so it is fast and rebases the decode;
 *   * `-output_ts_offset` puts the presentation timestamps back where they
 *     belong in the film, so time does not restart at every boundary;
 *   * a keyframe is forced at t=0 so the segment decodes without its
 *     predecessor, which is the whole premise of switching variants mid-film.
 *
 * MPEG-TS rather than fragmented MP4 because it needs no initialisation
 * segment: each piece is self-contained, so a variant switch is just the next
 * request.
 */
export const segment = (options: SegmentOptions): ReadonlyArray<string> =>
  renderAll([
    ...preamble,
    Arg.SeekInput({ at: options.startSeconds }),
    Arg.Input({ path: options.file }),
    Arg.Duration({ seconds: options.durationSeconds }),
    Arg.Map({ stream: options.videoIndex }),
    ...Option.match(options.audioIndex, {
      onNone: () => [],
      onSome: (stream) => [Arg.Map({ stream })]
    }),
    ...videoFor(options.rung),
    Arg.ForceKeyFrames({ expression: "expr:gte(t,0)" }),
    Arg.Audio({ codec: "aac" }),
    Arg.AudioChannels({ count: 2 }),
    Arg.AudioBitrate({ rate: options.audioBitrate }),
    Arg.TimestampOffset({ seconds: options.startSeconds }),
    Arg.MuxDelay({ seconds: 0 }),
    Arg.MpegtsFlags({ flags: ["resend_headers"] }),
    Arg.Format({ muxer: "mpegts" }),
    Arg.Output({ target: "pipe:1" })
  ])

/** Extract one subtitle track as WebVTT on stdout. */
export const extractSubtitles = (file: FilePath, stream: StreamIndex): ReadonlyArray<string> =>
  renderAll([
    ...preamble,
    Arg.Input({ path: file }),
    Arg.Map({ stream }),
    Arg.Format({ muxer: "webvtt" }),
    Arg.Output({ target: "pipe:1" })
  ])

/** ffprobe is a different binary with a different flag vocabulary. */
export const probe = (file: FilePath): ReadonlyArray<string> => [
  "-v",
  "error",
  "-print_format",
  "json",
  "-show_streams",
  "-show_format",
  file
]
