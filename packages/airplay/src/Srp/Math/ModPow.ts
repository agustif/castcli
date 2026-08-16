/**
 * Modular exponentiation, which is the only expensive thing SRP does.
 *
 * Four of the protocol's values are a power of something modulo a 3072-bit
 * prime, so this is the whole of the arithmetic and the whole of the cost. It
 * is written out rather than borrowed because `BigInt` has no `**` that reduces
 * as it goes: `base ** exponent % modulus` computes a number with roughly
 * 2^256 * 3072 bits before taking the remainder, which does not finish and does
 * not fail — it hangs, and a hang is the hardest bug on this list to attribute.
 *
 * @since 0.1.0
 */

/**
 * `base ^ exponent mod modulus`, by square-and-multiply.
 *
 * **Details**
 *
 * The exponent is consumed one bit at a time from the bottom, squaring a
 * running base each round and multiplying it into the accumulator wherever the
 * bit is set. Every intermediate is reduced immediately, so nothing ever grows
 * past twice the width of the modulus.
 *
 * **Gotchas**
 *
 * This is *not* constant-time, and cannot be made so on `BigInt`: the multiply
 * happens only on set bits, `BigInt` multiplication is itself variable-time,
 * and the engine gives no way to opt out. The reasoning for accepting that
 * here, rather than reaching for a constant-time library:
 *
 *  - The secrets are a 32-byte ephemeral private value that exists for one
 *    exchange and is then discarded, and a six-digit PIN the user reads off a
 *    television. Neither is reused, so a timing signal cannot be accumulated
 *    across runs the way it can against a long-lived signing key.
 *  - The attacker is on the far side of a socket, on a home network, measuring
 *    a single exponentiation through a TCP round trip and a JIT. The noise
 *    floor is orders of magnitude above the signal.
 *  - Six digits is a million guesses. HomeKit's answer to that is the pairing
 *    lockout — three wrong proofs and the accessory refuses to pair — not the
 *    timing profile of the exponentiation. An attacker who can guess is a
 *    bigger problem than an attacker who can time.
 *
 * What would change that judgement: reusing a private value across exchanges,
 * or moving a long-lived key through this function. Neither happens — the
 * long-lived keys in HomeKit are Ed25519, and they never touch this file.
 *
 * @example
 * ```ts
 * modPow(5n, 3n, 13n) // => 8n
 * ```
 *
 * @category arithmetic
 * @since 0.1.0
 */
export const modPow = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
  let result = 1n
  let square = base % modulus
  let remaining = exponent
  while (remaining > 0n) {
    result = (remaining & 1n) === 1n ? (result * square) % modulus : result
    square = (square * square) % modulus
    remaining >>= 1n
  }
  return result
}
