// Environment-level configuration.
//
// These are the knobs you set once for a machine or a network, as opposed to
// the per-invocation choices that belong on the command line. Config in v4 is
// schema-driven, so an out-of-range port fails with a decode error naming the
// variable rather than silently becoming NaN.

import { Config, Duration, Schema } from "effect"
import { AudioBitrate, Ipv4, Port } from "@castcli/domain"

const withDefault = <T>(codec: Schema.ConstraintCodec<T, unknown>, path: string, fallback: T) =>
  Config.schema(codec, path).pipe(Config.withDefault(fallback))

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
   * Overrides the advertised LAN address. Normally auto-detected; set it when a
   * machine has several interfaces and picks the wrong one — the failure mode
   * this whole tool exists to avoid.
   */
  advertiseHost: Config.schema(Ipv4, "CAST_ADVERTISE_HOST").pipe(Config.option)
})

export type AppConfig = Config.Success<typeof AppConfig>
