/**
 * Comparing two proofs without leaking where they first differ.
 *
 * @since 0.1.0
 */

/**
 * Whether two octet strings are identical, without an early exit.
 *
 * **Details**
 *
 * Every octet is read and the differences are accumulated into one value, so
 * the work done does not depend on where the first mismatch is. `===` on
 * strings, `Array.prototype.every`, and a plain loop with a `break` all return
 * as soon as they can, which turns "how long did the accessory take to reject
 * me" into "how many leading octets of the proof were right" — enough to forge
 * a proof one octet at a time without knowing the password.
 *
 * **Gotchas**
 *
 * "Without an early exit" is the honest claim, and it is weaker than "constant
 * time". A JavaScript engine may still branch, cache, or deoptimise underneath
 * this, and there is no way to forbid that from here. It is worth having
 * anyway: the early-exit leak is a first-order, remotely measurable signal —
 * it grows the attacker's advantage from 2^-512 to 64 guesses — whereas what
 * remains is a second-order effect through a JIT and a network. Where a real
 * constant-time comparison is available it should be used instead; Effect's
 * `Crypto` service does not expose one in this version, and inventing a
 * `node:crypto` dependency here to reach `timingSafeEqual` would put a `node:`
 * import in the middle of a platform-independent module.
 *
 * Lengths are compared first and short-circuit. That leaks only the length,
 * which is fixed by the protocol at 64 and is not a secret.
 *
 * @example
 * ```ts
 * equal(Uint8Array.from([1, 2]), Uint8Array.from([1, 3])) // => false
 * ```
 *
 * @category comparison
 * @since 0.1.0
 */
export const equal = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.reduce((difference, octet, index) => difference | (octet ^ (right[index] ?? 0)), 0) === 0
