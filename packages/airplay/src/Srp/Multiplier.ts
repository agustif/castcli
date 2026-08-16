/**
 * k — the multiplier that makes this SRP-6a rather than SRP-6.
 *
 * `k` mixes the verifier into the server's public value: `B = k*v + g^b`. SRP-3
 * used `k = 3`, and that constant is what SRP-6a was created to remove, because
 * a fixed small multiplier lets an attacker who has seen a verifier construct a
 * B that cancels it. Deriving `k` from the group instead ties the multiplier to
 * N and g, so it cannot be chosen.
 *
 * @since 0.1.0
 */
import { Crypto, Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as Group from "./Group.ts"
import { hash } from "./Hash.ts"
import { toBigInt } from "./Math/index.ts"

/**
 * `k = H(N | PAD(g))`.
 *
 * **Details**
 *
 * The generator is padded to the full width of the modulus — for the 3072-bit
 * group that means 383 zero bytes followed by `05`. RFC 5054 §2.6 introduced
 * PAD() for exactly this hash.
 *
 * **Gotchas**
 *
 * This is the first of the two places the generator is hashed, and the two
 * disagree: here it is padded, and inside M1 it is the single byte `05`. The
 * variant was not chosen by reading — both were implemented and run against
 * Apple's vectors, and `H(N | g)` with a one-byte `g` yields a `k` that
 * produces a B the vector does not contain. `Math/Pad.ts` carries the full
 * record; `Proof/GroupDigest.ts` is the other half of it.
 *
 * A pure function of the group, so a caller that computes it once per process
 * rather than once per exchange loses nothing. It is not memoised here because
 * a cache keyed on a mutable record is a worse bug than a repeated SHA-512.
 *
 * @example
 * ```ts
 * const k = multiplier(Group.rfc5054)
 * // Effect<bigint, PlatformError, Crypto.Crypto>
 * ```
 *
 * @category derivation
 * @since 0.1.0
 */
export const multiplier = (
  group: Group.Group
): Effect.Effect<bigint, PlatformError, Crypto.Crypto> =>
  Effect.map(
    hash(Group.encode(group, group.modulus), Group.encode(group, group.generator)),
    toBigInt
  )
