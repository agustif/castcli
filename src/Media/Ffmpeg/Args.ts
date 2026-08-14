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

import { Data, Match, Schema } from "effect"
import type { Bitrate, Seconds, StreamIndex } from "../../Domain/Brands.ts"
import { Rung } from "../../Domain/Rung.ts"

// --- closed vocabularies -----------------------------------------------------

export const VideoCodec = Schema.Literals(["copy", "h264_videotoolbox", "libx264"])
export type VideoCodec = typeof VideoCodec.Type

/** AAC-LC is the one audio codec every Cast receiver accepts. */
export const AudioCodec = Schema.Literals(["copy", "aac", "libmp3lame"])
export type AudioCodec = typeof AudioCodec.Type

export const Muxer = Schema.Literals(["mp4", "matroska", "webvtt", "mpegts"])
export type Muxer = typeof Muxer.Type

export const LogLevel = Schema.Literals(["quiet", "error", "warning", "info", "debug"])
export type LogLevel = typeof LogLevel.Type

/**
 * `frag_keyframe+empty_moov+default_base_moof` is what makes an MP4 playable
 * before it is complete — without it the receiver waits for a moov atom that a
 * live pipe never produces.
 */
export const MovFlag = Schema.Literals([
  "frag_keyframe",
  "empty_moov",
  "default_base_moof",
  "faststart"
])
export type MovFlag = typeof MovFlag.Type

export const H264Profile = Schema.Literals(["baseline", "main", "high"])
export type H264Profile = typeof H264Profile.Type

// --- options -----------------------------------------------------------------

export type Arg = Data.TaggedEnum<{
  readonly Banner: { readonly hidden: boolean }
  readonly Log: { readonly level: LogLevel }
  readonly NoStdin: {}
  /** Input seeking. Must come before `Input` to be fast and to rebase timestamps. */
  readonly SeekInput: { readonly at: Seconds }
  readonly Input: { readonly path: string }
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
  readonly AudioBitrate: { readonly rate: string }
  readonly Format: { readonly muxer: Muxer }
  readonly MovFlags: { readonly flags: ReadonlyArray<MovFlag> }
  readonly Output: { readonly target: string }
}>

export const Arg = Data.taggedEnum<Arg>()

export const render: (arg: Arg) => ReadonlyArray<string> = Match.type<Arg>().pipe(
  Match.tag("Banner", ({ hidden }) => hidden ? ["-hide_banner"] : []),
  Match.tag("Log", ({ level }) => ["-loglevel", level]),
  Match.tag("NoStdin", () => ["-nostdin"]),
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
  Match.tag("Format", ({ muxer }) => ["-f", muxer]),
  Match.tag("MovFlags", ({ flags }) => ["-movflags", flags.join("+")]),
  Match.tag("Output", ({ target }) => [target]),
  Match.exhaustive
)

export const renderAll = (args: ReadonlyArray<Arg>): ReadonlyArray<string> =>
  args.flatMap(render)

// --- invocations -------------------------------------------------------------

export interface TranscodeOptions {
  readonly file: string
  readonly offsetSeconds: Seconds
  readonly videoIndex: StreamIndex
  readonly audioIndex: StreamIndex | null
  readonly rung: Rung
  readonly audioBitrate: string
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
    ...(options.audioIndex === null ? [] : [Arg.Map({ stream: options.audioIndex })]),
    ...videoFor(options.rung),
    Arg.Audio({ codec: "aac" }),
    Arg.AudioChannels({ count: 2 }),
    Arg.AudioBitrate({ rate: options.audioBitrate }),
    Arg.Format({ muxer: "mp4" }),
    Arg.MovFlags({ flags: ["frag_keyframe", "empty_moov", "default_base_moof"] }),
    Arg.Output({ target: "pipe:1" })
  ])

/** Extract one subtitle track as WebVTT on stdout. */
export const extractSubtitles = (file: string, stream: StreamIndex): ReadonlyArray<string> =>
  renderAll([
    ...preamble,
    Arg.Input({ path: file }),
    Arg.Map({ stream }),
    Arg.Format({ muxer: "webvtt" }),
    Arg.Output({ target: "pipe:1" })
  ])

/** ffprobe is a different binary with a different flag vocabulary. */
export const probe = (file: string): ReadonlyArray<string> => [
  "-v",
  "error",
  "-print_format",
  "json",
  "-show_streams",
  "-show_format",
  file
]
