/**
 * The byte lengths HAP's cryptographic primitives are fixed at.
 *
 * Every one of these is a constant of the wire format rather than a parameter:
 * an Ed25519 public key is 32 bytes because Ed25519 says so, and a HAP session
 * key is 32 bytes because HAP derives exactly one ChaCha20 key from every HKDF
 * call. They are gathered here so that the checks in `Suite.make` and the
 * framing code that has to reserve room for a tag quote the same number, rather
 * than each writing `16` and drifting apart.
 *
 * @since 0.1.0
 */

/**
 * The fixed lengths, in bytes.
 *
 * **Details**
 *
 * `KEY` is both the ChaCha20-Poly1305 key length and the output length of
 * `Suite.hkdfSha512`, which is not a coincidence — the only thing HAP derives a
 * key for is the AEAD.
 *
 * **Gotchas**
 *
 * `NONCE` is 12, but a HAP nonce is never written as twelve bytes by hand: the
 * leading four are always zero and the trailing eight are either a label or a
 * counter. Build one with `Nonce.label` or `Nonce.counter` instead.
 *
 * @example
 * ```ts
 * import { Sizes } from "./Sizes.ts"
 *
 * // How much longer a sealed frame is than its plaintext.
 * const overhead = Sizes.TAG // => 16
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export const Sizes = {
  /** A ChaCha20-Poly1305 key, and the output of every HAP HKDF derivation. */
  KEY: 32,
  /** A ChaCha20-Poly1305 nonce: four zero bytes and an eight-byte suffix. */
  NONCE: 12,
  /** The Poly1305 tag appended to every sealed frame. */
  TAG: 16,
  /** The eight-byte suffix of a nonce — a label, or a little-endian counter. */
  NONCE_SUFFIX: 8,
  /** An Ed25519 or X25519 public key, and an X25519 shared secret. */
  PUBLIC_KEY: 32,
  /**
   * An Ed25519 seed or an X25519 scalar. Both are 32 uniformly random bytes,
   * which is why `Suite` can derive key generation from random bytes alone.
   */
  PRIVATE_KEY: 32,
  /** An Ed25519 signature. */
  SIGNATURE: 64
} as const
