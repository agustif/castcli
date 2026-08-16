// Matching a C name literally, and only where a C name can begin.
//
// Every reader here is handed a name by its caller — `srp_salt`,
// `kHAPPairingFlag_` — and looks for it in the source. Two things go wrong if
// that name is simply pasted into a regular expression.
//
// The first is punctuation: an identifier cannot contain a `.` or a `*`, but a
// caller passing a *prefix* by mistake, or a name from a generated table, can
// hand over something that the regular expression engine reads as syntax. The
// result is a pattern that matches the wrong thing rather than an error.
//
// The second, and the one that has teeth here, is boundaries. `salt` occurs
// inside `hkdf_salt` and `srp_salt`; `kHAPPairingFlag_` occurs inside nothing,
// but `kHAPPairing` occurs inside all four HomeKit families. Without a
// boundary, asking for one family silently returns the union of several.

/** Every character the regular expression engine treats as syntax. */
const quoted = (name: string): string => name.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")

/**
 * Regex source matching `name` only where an identifier may begin.
 *
 * **When to use**
 *
 * For a *prefix* — a family of constants sharing a leading string, where the
 * caller intends the match to continue into the rest of the name. The right
 * edge is deliberately left open.
 *
 * @example
 * ```ts
 * import { startingAt } from "./Identifier.ts"
 *
 * const members = new RegExp(`${startingAt("kHAPPairingFlag_")}(\\w+)`, "g")
 * // matches kHAPPairingFlag_Transient, and not xkHAPPairingFlag_Transient
 * ```
 *
 * @category patterns
 * @since 0.1.0
 */
export const startingAt = (name: string): string => `(?<![A-Za-z0-9_])${quoted(name)}`

/**
 * Regex source matching `name` as a whole identifier, both edges closed.
 *
 * **When to use**
 *
 * For a name the caller means exactly: an array or a `#define` it wants the
 * value of. Without the right-hand boundary, asking for `salt` would find
 * `salt_len` first and report its value as the salt.
 *
 * @example
 * ```ts
 * import { whole } from "./Identifier.ts"
 *
 * const declaration = new RegExp(`${whole("salt")}\\s*\\[`)
 * // matches salt[], and not hkdf_salt[] or salt_len[]
 * ```
 *
 * @category patterns
 * @since 0.1.0
 */
export const whole = (name: string): string => `${startingAt(name)}(?![A-Za-z0-9_])`
