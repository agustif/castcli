/**
 * S as the accessory computes it, from the verifier it stored.
 *
 * This is the half Apple's vectors verify directly: they carry `b`, `A`, `v`
 * and `u`, which is exactly the input to this function, and the `S` it should
 * produce. There is no client private `a` anywhere in the vectors, so this is
 * the only half that can be checked against hardware-derived numbers — which is
 * why the client half is checked against *this* one instead.
 *
 * @since 0.1.0
 */
import type * as Group from "../Group.ts"
import { modPow } from "../Math/index.ts"

/**
 * `S = (A * v^u) ^ b mod N`.
 *
 * **Details**
 *
 * Pure arithmetic: no hashing, no service, no failure. Everything hashed has
 * already been hashed by the time this is called, which is what makes it a
 * function rather than an effect and what makes it directly comparable against
 * the vector without a runtime in the way.
 *
 * The multiplication is reduced before exponentiating. Not doing so is
 * arithmetically harmless — `modPow` reduces its base — but it would build a
 * 6144-bit intermediate on every call for nothing.
 *
 * **Gotchas**
 *
 * The result is only meaningful when `A mod N ≠ 0`; with `A ≡ 0` this returns
 * `0` for every verifier and every `b`, which is precisely the attack
 * `Errors.InvalidPublicKey` exists to stop. The check is not made here because
 * this function has no error channel and a silent clamp would be worse than a
 * wrong answer — `Server` makes it before calling.
 *
 * @example
 * ```ts
 * fromVerifier(Group.rfc5054, {
 *   clientPublic: A, verifier: v, scrambler: u, privateKey: b
 * }) // => bigint
 * ```
 *
 * @category derivation
 * @since 0.1.0
 */
export const fromVerifier = (
  group: Group.Group,
  options: {
    /** A, as sent by the client. */
    readonly clientPublic: bigint
    /** v, as stored at setup. */
    readonly verifier: bigint
    /** u, from both public values. */
    readonly scrambler: bigint
    /** b, this exchange's ephemeral private value. */
    readonly privateKey: bigint
  }
): bigint =>
  modPow(
    (options.clientPublic * modPow(options.verifier, options.scrambler, group.modulus)) %
      group.modulus,
    options.privateKey,
    group.modulus
  )
