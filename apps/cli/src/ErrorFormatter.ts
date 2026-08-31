// Error formatting that surfaces Schema issues with their full path.
//
// When a Schema decode fails the default Effect error is `InvalidValue` with no
// issue tree, which is useless for debugging pairing failures. This formatter
// extracts Schema issues and pretty-prints them, making errors like "Uint8Array
// decode failed at airplayPairings.controllerPublicKey" visible instead of bare
// `error: InvalidValue`.

import { Effect, Option, SchemaIssue } from "effect"

/**
 * Format a Schema issue tree into a readable error message.
 * Uses Effect's default formatter which includes the path and expected/actual.
 */
const formatSchemaIssue = (issue: SchemaIssue.Issue): string => {
  const formatter = SchemaIssue.makeFormatterDefault()
  return formatter(issue)
}

/**
 * Check if value has a specific property of a specific type.
 */
const hasProperty = <T>(
  value: unknown,
  key: string,
  check: (val: unknown) => val is T
): value is Record<string, unknown> & { [K in typeof key]: T } =>
  typeof value === "object" && value !== null && key in value && check(value[key as keyof typeof value])

const isString = (val: unknown): val is string => typeof val === "string"

/**
 * Format any error for user display, with special handling for Schema issues.
 * 
 * Returns a human-readable message with:
 * - Schema issues: full path + expected/actual
 * - Tagged errors: message or tag
 * - Defects: message + cause chain
 */
export const formatError = (error: unknown): string => {
  // Schema validation issue
  return Option.match(
    Option.filter(
      Option.fromNullishOr(error),
      (e): e is { _tag: string; issue: SchemaIssue.Issue } =>
        hasProperty(e, "_tag", isString) && hasProperty(e, "issue", () => true)
    ),
    {
      onSome: (e) => `Schema validation failed:\n${formatSchemaIssue(e.issue)}`,
      onNone: () =>
        // String error
        Option.match(Option.filter(Option.fromNullishOr(error), isString), {
          onSome: (s) => (s.length > 0 ? s : "unknown error"),
          onNone: () =>
            // Tagged error with message
            Option.match(
              Option.filter(
                Option.fromNullishOr(error),
                (e): e is { _tag: string; message: string } =>
                  hasProperty(e, "_tag", isString) && hasProperty(e, "message", isString)
              ),
              {
                onSome: (e) => (e.message.length > 0 ? e.message : e._tag),
                onNone: () =>
                  // Tagged error without message
                  Option.match(
                    Option.filter(
                      Option.fromNullishOr(error),
                      (e): e is { _tag: string } => hasProperty(e, "_tag", isString)
                    ),
                    {
                      onSome: (e) => e._tag,
                      onNone: () =>
                        // Defect with cause
                        Option.match(
                          Option.filter(
                            Option.fromNullishOr(error),
                            (e): e is { message: string; cause: unknown } =>
                              hasProperty(e, "message", isString) && hasProperty(e, "cause", () => true)
                          ),
                          {
                            onSome: (e) => `${e.message}\nCause: ${formatError(e.cause)}`,
                            onNone: () => "unknown error"
                          }
                        )
                    }
                  )
              }
            )
        })
    }
  )
}

/**
 * Log an error with full details (Schema issues, cause chain) at error level.
 * Use this before failing or rethrowing to capture diagnostics.
 */
export const logError = (error: unknown, context: string) =>
  Effect.logError(`${context}: ${formatError(error)}`)
