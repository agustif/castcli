/**
 * A generated key pair, with the private half redacted.
 *
 * @since 0.1.0
 */
import type { Redacted } from "effect"

/**
 * A public key and the private key it was derived from.
 *
 * **Details**
 *
 * Both halves are 32 bytes for both algorithms this service generates, which is
 * exactly why the private half is `Redacted`: an Ed25519 seed, an X25519 scalar
 * and a public key are indistinguishable by inspection, so the type is the only
 * thing that keeps a long-term signing seed out of a log line that meant to
 * print an identity.
 *
 * `Redacted.value` unwraps it. That call is the moment to ask whether the
 * secret is about to leave the process.
 *
 * **Gotchas**
 *
 * Nothing here records *which* algorithm the pair belongs to. An Ed25519 seed
 * handed to `x25519SharedSecret` is accepted by the type system and by the
 * platform, and produces a shared secret that no peer will agree with. Keep the
 * two in distinctly named bindings; the compiler will not.
 *
 * @category models
 * @since 0.1.0
 */
export interface KeyPair {
  /** The public half, as it goes on the wire. */
  readonly publicKey: Uint8Array
  /** The private half: an Ed25519 seed or an X25519 scalar. */
  readonly privateKey: Redacted.Redacted<Uint8Array>
}
