// Telemetry setup for castcli using Effect Logger.
//
// Provides Effect's native Logger with console output. Spans are logged via
// Effect.withSpan which integrates naturally with Effect's Logger.
//
// The --log-level flag controls what gets logged via Effect.logLevel.

import { Effect } from "effect"

/**
 * Log level from --log-level flag or LOG_LEVEL env var.
 * Returns the Effect log level name.
 */
export const logLevelFromString = (level: string | undefined): string => {
  const normalized = (level ?? "info").toLowerCase()
  
  return normalized === "debug" || normalized === "trace"
    ? "Debug"
    : normalized === "warning" || normalized === "warn"
      ? "Warn"
      : normalized === "error"
        ? "Error"
        : normalized === "fatal"
          ? "Fatal"
          : "Info"
}

/**
 * Apply log level annotation to an Effect program.
 * Logs below this level will be filtered out.
 */
export const withLogLevel = <A, E, R>(
  level: string
) => (effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.annotateLogs(effect, { level })

