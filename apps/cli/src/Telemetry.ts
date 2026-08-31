// Telemetry setup for castcli using Effect Logger.
//
// Provides Effect's native Logger with console output. Spans are logged via
// Effect.withSpan which integrates naturally with Effect's Logger.
//
// The --log-level flag controls what gets logged via References.MinimumLogLevel.

import { Effect, LogLevel, References } from "effect"

/**
 * Convert string log level to Effect LogLevel literal.
 * Maps common log level names to Effect's LogLevel string literals.
 */
export const logLevelFromString = (level: string | undefined): LogLevel.LogLevel => {
  const normalized = (level ?? "info").toLowerCase()
  
  return normalized === "debug"
    ? "Debug"
    : normalized === "trace"
      ? "Trace"
      : normalized === "warning" || normalized === "warn"
        ? "Warn"
        : normalized === "error"
          ? "Error"
          : normalized === "fatal"
            ? "Fatal"
            : "Info"
}

/**
 * Apply minimum log level to an Effect program.
 * Logs below this level will be filtered out.
 */
export const withLogLevel = <A, E, R>(
  level: string
) => (effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, References.MinimumLogLevel, logLevelFromString(level))

