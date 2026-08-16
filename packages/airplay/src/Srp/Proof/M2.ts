/**
 * M2 — the accessory proving it held the verifier.
 *
 * The half that is easy to skip. A client that sends M1, receives anything at
 * all, and proceeds has authenticated itself to the accessory and learned
 * nothing about the accessory; the exchange is then one-directional, and a
 * device that never had the verifier can complete it.
 *
 * @since 0.1.0
 */
import { Crypto, Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as Group from "../Group.ts"
import { hash } from "../Hash.ts"

/**
 * `M2 = H( PAD(A) | M1 | K )`.
 *
 * **Details**
 *
 * Three fields, all fixed-width, and the reason it can be this short is that M1
 * already binds everything else — the group, the identity, the salt and both
 * public values are inside it. M2 only has to demonstrate that whoever produced
 * it saw M1 *and* holds K, and K is only derivable from the verifier.
 *
 * Reproduces Apple's vector exactly.
 *
 * **Gotchas**
 *
 * `m1` here is the M1 that was actually received, not one recomputed for the
 * occasion — on the server side those are the same value only because the
 * server checked them equal first, and computing M2 over its own M1 without
 * that check would let it answer any proof at all.
 *
 * As in M1, `sessionKey` is K and not S.
 *
 * @example
 * ```ts
 * const proof = m2(Group.rfc5054, { clientPublic: A, m1, sessionKey: K })
 * // Effect<Uint8Array, PlatformError, Crypto.Crypto> — 64 octets
 * ```
 *
 * @category proofs
 * @since 0.1.0
 */
export const m2 = (
  group: Group.Group,
  options: {
    readonly clientPublic: bigint
    /** The M1 that was exchanged. */
    readonly m1: Uint8Array
    /** K, the session key. */
    readonly sessionKey: Uint8Array
  }
): Effect.Effect<Uint8Array, PlatformError, Crypto.Crypto> =>
  hash(Group.encode(group, options.clientPublic), options.m1, options.sessionKey)
