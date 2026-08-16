/**
 * H() — the one hash the whole exchange is built from.
 *
 * SRP names a hash function once and then uses it for everything: the
 * multiplier, the password key, the scrambling parameter, the session key and
 * both proofs. RFC 5054 pairs its groups with SHA-1; HomeKit uses SHA-512 with
 * the same 3072-bit group, and `HAPCrypto.h` states it structurally rather than
 * in prose — `SRP_SESSION_KEY_BYTES` and `SRP_PROOF_BYTES` are both 64, and
 * `SRP_SCRAMBLING_PARAMETER_BYTES` is 64, which is a SHA-512 digest and nothing
 * else.
 *
 * It goes through the `Crypto` service rather than `node:crypto` for the reason
 * every service in this codebase exists: the Node layer is one file, and a
 * browser or Deno layer is a new file rather than a rewrite of this one.
 *
 * @since 0.1.0
 */
import { Crypto, Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"

/**
 * The width of a digest, in octets.
 *
 * **Details**
 *
 * Exported because two things downstream are defined in terms of it and would
 * otherwise repeat the literal 64: M1 XORs two digests together and needs them
 * the same length, and `Proof.equal` compares fixed-width values.
 *
 * @category constants
 * @since 0.1.0
 */
export const BYTES = 64

/**
 * Concatenate, then digest, in one step.
 *
 * **Details**
 *
 * Every hash in SRP is over a concatenation of fields with no separators and no
 * lengths — `H(salt | H(I | ":" | P))`, `H(PAD(A) | PAD(B))` and so on — so the
 * concatenation is folded in here rather than left to each caller. That is a
 * safety property, not a convenience: a caller that concatenates for itself can
 * quietly hash the wrong number of arguments, whereas a caller here cannot pass
 * anything but the full list.
 *
 * **Gotchas**
 *
 * Because there are no separators, this is only unambiguous when every field
 * but the last has a fixed width. That is exactly why `salt` (16 octets) and
 * the padded group values (384 octets) are safe to run together, and exactly
 * why a variable-length username is only ever hashed *first*, on its own, into
 * a fixed-width digest before being concatenated with anything.
 *
 * @example
 * ```ts
 * const digest = hash(Uint8Array.from([1]), Uint8Array.from([2]))
 * // Effect<Uint8Array, PlatformError, Crypto.Crypto> — 64 octets of SHA-512
 * ```
 *
 * @category hashing
 * @since 0.1.0
 */
export const hash = (
  ...parts: ReadonlyArray<Uint8Array>
): Effect.Effect<Uint8Array, PlatformError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    return yield* crypto.digest("SHA-512", concat(parts))
  })

/** One buffer from many, sized once so the parts are copied and not grown. */
const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}

/**
 * A string as the octets a protocol field carries.
 *
 * **Details**
 *
 * The username and the PIN enter the exchange as text and leave as bytes, and
 * the encoding is UTF-8. For HomeKit that is exact rather than merely
 * defensible: the username is the ASCII literal `Pair-Setup` and the setup code
 * is eight ASCII digits with two hyphens, so UTF-8, ASCII and Latin-1 all agree
 * and the choice can never be observed. It is named here anyway, because the
 * one thing worse than picking an encoding is picking it implicitly.
 *
 * @example
 * ```ts
 * utf8(":") // => Uint8Array [0x3a]
 * ```
 *
 * @category encoding
 * @since 0.1.0
 */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
