/**
 * S as the sender computes it, from the PIN the user typed.
 *
 * The mirror of `FromVerifier`, and the reason the two files sit together: they
 * are two expressions that must evaluate to the same number, and nothing but
 * running both proves it. Apple's vectors carry no client private value, so
 * agreement with the vector-verified server half is the strongest check
 * available without a television in the room.
 *
 * @since 0.1.0
 */
import type * as Group from "../Group.ts"
import { modPow } from "../Math/index.ts"

/**
 * `S = (B - k * g^x) ^ (a + u*x) mod N`.
 *
 * **Details**
 *
 * The base subtracts the server's `k*v` term back out — the client can
 * reconstruct `v` as `g^x` because it knows the password — leaving `g^b`, which
 * it then raises to `a + u*x`. The server reaches the same number from the other
 * direction, and the algebra that makes them equal is the protocol.
 *
 * **Gotchas**
 *
 * Two traps, both silent.
 *
 * The subtraction goes negative roughly half the time. `%` in JavaScript keeps
 * the sign of the dividend, so `(B - k*g^x) % N` can be negative, and `modPow`
 * on a negative base gives a negative-signed result that is wrong and still a
 * number. It is normalised back into `[0, N)` here — the `+ modulus` term —
 * rather than relied upon anywhere downstream.
 *
 * The exponent `a + u*x` must *not* be reduced modulo N. It is an exponent, so
 * the modulus that would apply is the group order, N-1 for a safe prime's full
 * group — not N. Reducing it mod N is a no-op for small `a` and quietly wrong
 * for large ones, which makes it a bug that appears once in a while and cannot
 * be reproduced. It is left unreduced; `modPow` walks its bits and does not
 * care that it is 512 bits wide.
 *
 * @example
 * ```ts
 * fromPassword(Group.rfc5054, {
 *   serverPublic: B, multiplier: k, passwordKey: x, privateKey: a, scrambler: u
 * }) // => bigint
 * ```
 *
 * @category derivation
 * @since 0.1.0
 */
export const fromPassword = (
  group: Group.Group,
  options: {
    /** B, as sent by the accessory. */
    readonly serverPublic: bigint
    /** k, from the group. */
    readonly multiplier: bigint
    /** x, from the salt and the PIN. */
    readonly passwordKey: bigint
    /** a, this exchange's ephemeral private value. */
    readonly privateKey: bigint
    /** u, from both public values. */
    readonly scrambler: bigint
  }
): bigint => {
  const offset = options.multiplier *
    modPow(group.generator, options.passwordKey, group.modulus)
  const base = (((options.serverPublic - offset) % group.modulus) + group.modulus) %
    group.modulus
  return modPow(
    base,
    options.privateKey + options.scrambler * options.passwordKey,
    group.modulus
  )
}
