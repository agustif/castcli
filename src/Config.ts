// Environment-level configuration.
//
// These are the knobs you set once for a machine or a network, as opposed to
// the per-invocation choices that belong on the command line. Config in v4 is
// schema-driven, so an out-of-range port fails with a decode error naming the
// variable rather than silently becoming NaN.

import { Config, Duration, Schema } from "effect"
import * as Brands from "./Domain/Brands.ts"

const withDefault = <T>(codec: Schema.ConstraintCodec<T, unknown>, path: string, fallback: T) =>
  Config.schema(codec, path).pipe(Config.withDefault(fallback))

export const AppConfig = Config.all({
  /** Port the media server listens on for the receiver to pull from. */
  port: withDefault(Brands.Port, "CAST_PORT", Brands.port(8021)),

  /** Cast devices always listen on 8009; overridable for emulators and tests. */
  devicePort: withDefault(Brands.Port, "CAST_DEVICE_PORT", Brands.port(8009)),

  /** How long each mDNS sweep waits for replies. */
  discoveryTimeout: withDefault(
    Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 250, maximum: 30_000 })),
      Schema.decodeTo(Schema.DurationFromMillis)
    ),
    "CAST_DISCOVERY_TIMEOUT_MS",
    Duration.seconds(4)
  ),

  /** AAC is the one audio codec every Cast receiver accepts. */
  audioBitrate: withDefault(Schema.String, "CAST_AUDIO_BITRATE", "128k"),

  /**
   * Overrides the advertised LAN address. Normally auto-detected; set it when a
   * machine has several interfaces and picks the wrong one — the failure mode
   * this whole tool exists to avoid.
   */
  advertiseHost: Config.schema(Schema.String, "CAST_ADVERTISE_HOST").pipe(Config.option)
})

export type AppConfig = typeof AppConfig extends Config.Config<infer A> ? A : never
