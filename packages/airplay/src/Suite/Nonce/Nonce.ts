/**
 * The twelve bytes a HAP frame is sealed under.
 *
 * A nonce is the one AEAD input that is neither secret nor checked. Get the key
 * wrong and nothing decrypts anywhere; get the nonce wrong and the tag fails to
 * verify, which is reported — by every implementation, ours included — as
 * "authentication error". That message is indistinguishable from an attacker,
 * from a corrupted frame and from a bug five layers away, so the single most
 * useful thing this module can do is make a wrong nonce unrepresentable rather
 * than diagnosable.
 *
 * Hence: a `Nonce` is opaque, and the only ways to obtain one are the two
 * constructions HAP actually uses — {@link label} for pairing messages and
 * {@link counter} for the control channel. `Suite.seal` and `Suite.open` accept
 * nothing else, so there is no call site at which someone can pass twelve bytes
 * assembled by eye.
 *
 * @since 0.1.0
 */
import { Sizes } from "../Sizes.ts"

/**
 * The runtime marker that makes a `Nonce` more than a `Uint8Array`.
 *
 * @category type ids
 * @since 0.1.0
 */
export const TypeId = "~@castcli/airplay/Suite/Nonce"

/**
 * Twelve bytes: four zeros, then an eight-byte suffix.
 *
 * **Details**
 *
 * The leading zeros are not padding this module invented. RFC 8439 takes a
 * 96-bit nonce, and HAP's own implementation passes an eight-byte value and lets
 * the AEAD left-pad it — see `HAP_chacha20_poly1305_encrypt` in the vendored
 * sources, which is called with `sizeof nonce - 1` for a string of eight
 * characters. Writing the zeros here rather than relying on a padding rule
 * somewhere below means the twelve bytes that go on the wire are visible in one
 * place.
 *
 * **Gotchas**
 *
 * `bytes` is the live array, not a copy. Nothing in this package mutates it, and
 * a caller that does has changed the nonce of every frame that shares this
 * value.
 *
 * @category models
 * @since 0.1.0
 */
export interface Nonce {
  readonly [TypeId]: typeof TypeId
  /** The twelve bytes, ready to hand to the AEAD. */
  readonly bytes: Uint8Array
}

/**
 * Four zero bytes followed by the eight given ones.
 *
 * **Gotchas**
 *
 * Internal to this directory, and deliberately not re-exported from its
 * `index.ts`: it trusts its argument to be exactly `Sizes.NONCE_SUFFIX` bytes
 * and copies whatever it is given into a zeroed twelve-byte buffer, so a shorter
 * suffix would silently produce a nonce with trailing zeros rather than fail.
 * {@link label} and {@link counter} are the callers, and both check first.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromSuffix = (suffix: Uint8Array): Nonce => {
  const bytes = new Uint8Array(Sizes.NONCE)
  bytes.set(suffix, Sizes.NONCE - Sizes.NONCE_SUFFIX)
  return { [TypeId]: TypeId, bytes }
}
