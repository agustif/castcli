/**
 * a and b — the private value each side invents for one exchange and forgets.
 *
 * Both sides need the same thing: 32 random octets, unless a caller has one to
 * supply. It is one file rather than two because "where the randomness comes
 * from" is a single decision, and because that decision is the reason the whole
 * exchange can be tested at all.
 *
 * The randomness comes from Effect's `Crypto` service, not from `node:crypto`
 * and certainly not from `Math.random`. The payoff is not tidiness: a service
 * can be replaced by a layer, so a test can supply fixed bytes and a pairing
 * exchange — which is otherwise different every time it runs — becomes a
 * reproducible sequence of numbers that can be compared against Apple's.
 *
 * @since 0.1.0
 */
import { Crypto, Effect, Option } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { toBigInt } from "./Math/index.ts"

/**
 * How many octets an ephemeral private value has.
 *
 * **Details**
 *
 * 32, from `SRP_SECRET_KEY_BYTES` in `packages/airplay/vendor/HAPCrypto.h`, and
 * confirmed by the vector's `b` being exactly that long. RFC 5054 §3.1 asks for
 * at least 256 bits, so this is the minimum the specification allows rather
 * than a generous choice — but it is what the accessory on the other side uses,
 * and matching it is what makes the transcript comparable.
 *
 * @category constants
 * @since 0.1.0
 */
export const BYTES = 32

/**
 * The exchange's private value: supplied, or freshly random.
 *
 * **When to use**
 *
 * `Option.none()` in production — there is no reason ever to pin `a` or `b`
 * against a real device, and doing so would let anyone who learns the value
 * derive the session key from a recorded transcript.
 *
 * `Option.some(bytes)` in tests, and only there. Apple's vectors carry a
 * server-side `b`, and reproducing their `B`, `S` and proofs means using
 * exactly that value; without a way to inject it, the vectors could not be
 * checked at all and this module's central claim would be untestable.
 *
 * **Gotchas**
 *
 * A supplied value is used as-is, with no length check and no reduction modulo
 * anything. That is intentional — the vector's `b` must go in byte for byte —
 * but it means a caller passing a short or empty array gets a weak exponent
 * rather than an error. The parameter is an `Option` precisely so that reaching
 * for it is a deliberate act rather than a defaulted field someone fills in by
 * accident.
 *
 * @example
 * ```ts
 * const b = ephemeral(Option.some(SrpVectors.b)) // reproduces Apple's transcript
 * const a = ephemeral(Option.none())             // 32 fresh octets from Crypto
 * ```
 *
 * @category derivation
 * @since 0.1.0
 */
export const ephemeral = (
  supplied: Option.Option<Uint8Array>
): Effect.Effect<bigint, PlatformError, Crypto.Crypto> =>
  Effect.map(
    Option.match(supplied, {
      onNone: () => Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomBytes(BYTES)),
      onSome: (bytes: Uint8Array) => Effect.succeed(bytes)
    }),
    toBigInt
  )
