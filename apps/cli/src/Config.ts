// Environment-level configuration.
//
// These are the knobs you set once for a machine or a network, as opposed to
// the per-invocation choices that belong on the command line. Config in v4 is
// schema-driven, so an out-of-range port fails with a decode error naming the
// variable rather than silently becoming NaN.

import { Config, Duration, Schema, SchemaTransformation } from "effect"
import { AudioBitrate, Ipv4, Port } from "@castcli/domain"

const withDefault = <T>(codec: Schema.ConstraintCodec<T, unknown>, path: string, fallback: T) =>
  Config.schema(codec, path).pipe(Config.withDefault(fallback))

/**
 * A comma-separated preference list, decoded into an array so the environment
 * variable is parsed once here rather than split at every use.
 */
const Languages = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform({
      decode: (value: string): ReadonlyArray<string> =>
        value.split(",").map((language) => language.trim()).filter((language) =>
          language.length > 0
        ),
      encode: (languages: ReadonlyArray<string>) => languages.join(",")
    })
  )
)

export const AppConfig = Config.all({
  /** Port the media server listens on for the receiver to pull from. */
  port: withDefault(Port, "CAST_PORT", Port.make(8021)),

  /** Cast devices always listen on 8009; overridable for emulators and tests. */
  devicePort: withDefault(Port, "CAST_DEVICE_PORT", Port.make(8009)),

  /** How long each mDNS sweep waits for replies. */
  discoveryTimeout: withDefault(
    Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 250, maximum: 30_000 })),
      Schema.decodeTo(Schema.DurationFromMillis)
    ),
    "CAST_DISCOVERY_TIMEOUT_MS",
    Duration.seconds(4)
  ),

  /**
   * AAC is the one audio codec every Cast receiver accepts. Validated rather
   * than passed through: this string goes straight to ffmpeg, and a typo there
   * fails mid-transcode rather than at startup with the variable named.
   */
  audioBitrate: withDefault(AudioBitrate, "CAST_AUDIO_BITRATE", AudioBitrate.make("128k")),

  /**
   * Which audio track to prefer, best first, as ISO 639-2 codes.
   *
   * Set once per person rather than per invocation, which is the point: the
   * tool used to make you look up a stream index for every film. Matroska omits
   * the language element for English rather than writing `eng`, so `und` is
   * worth keeping in the list — it is how an English track in a foreign release
   * usually presents itself.
   */
  audioLanguages: withDefault(Languages, "CAST_AUDIO_LANGUAGES", ["eng", "und"]),

  /**
   * Which subtitle track to prefer. Separate from the audio list because the
   * common case is not one language: original audio with subtitles in your own.
   */
  subtitleLanguages: withDefault(Languages, "CAST_SUBTITLE_LANGUAGES", ["eng"]),

  /**
   * Overrides the advertised LAN address. Normally auto-detected; set it when a
   * machine has several interfaces and picks the wrong one — the failure mode
   * this whole tool exists to avoid.
   */
  advertiseHost: Config.schema(Ipv4, "CAST_ADVERTISE_HOST").pipe(Config.option)
})

export type AppConfig = Config.Success<typeof AppConfig>
