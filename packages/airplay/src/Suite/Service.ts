/**
 * The four cryptographic primitives HAP needs and Effect does not have.
 *
 * `Crypto` from `effect` already provides SHA digests and secure random bytes,
 * and a Node program gets them from `NodeCrypto.layer`. It stops there. HomeKit
 * pairing also needs HKDF-SHA512, ChaCha20-Poly1305, Ed25519 and X25519, and
 * this module is the sibling `Crypto` would have if it covered them: an
 * interface and a tag here, a `make` that derives everything derivable, and a
 * Node implementation in its own package (`NodeSuite`) that is the only file
 * mentioning `node:crypto`.
 *
 * That shape is the point. The boundary between "the platform gave us this" and
 * "we had to supply it" is visible in the imports, a browser or Deno runtime
 * replaces one file rather than being hunted for, and — the reason it is a
 * service at all — a test can supply a layer whose random bytes are fixed, which
 * is what makes a pairing exchange reproducible.
 *
 * @since 0.1.0
 */
import type { Effect, PlatformError, Redacted } from "effect"
import type { CiphertextWithTag } from "./CiphertextWithTag.ts"
import type { ForgedFrame } from "./Errors.ts"
import type { KeyPair } from "./KeyPair.ts"
import type * as Nonce from "./Nonce/index.ts"
import { Context } from "effect"

const TypeId = "~@castcli/airplay/Suite"

/**
 * The primitives HAP is built out of.
 *
 * **Details**
 *
 * Key material is `Redacted` and public values are plain `Uint8Array`, which
 * makes the split between the two visible at every call site. That is not
 * tidiness: pair-setup derives a session key from an SRP shared secret, and a
 * single `Effect.log` of that key hands an observer every frame of the session.
 *
 * Failures are `PlatformError`, the same type `Crypto` fails with, so a caller
 * that already handles "the host's cryptography refused" needs no second error
 * family. The one exception is {@link Suite.open}, which additionally fails with
 * `ForgedFrame` — see `Errors.ts` for why that distinction is worth a type.
 *
 * **Gotchas**
 *
 * Every argument here is 32 bytes except signatures, nonces and the caller's own
 * data, and none of them are distinguishable by inspection. `make` checks
 * lengths, so a 31-byte key fails as a bad argument rather than as an opaque
 * OpenSSL error, but nothing can check that a 32-byte value is the *right*
 * 32-byte value.
 *
 * @example
 * ```ts
 * import { Effect, Redacted } from "effect"
 * import { Suite } from "./Service.ts"
 * import * as Nonce from "./Nonce/index.ts"
 *
 * const program = Effect.gen(function*() {
 *   const suite = yield* Suite
 *   const key = yield* suite.hkdfSha512({
 *     key: Redacted.make(new Uint8Array(32)),
 *     salt: "Pair-Setup-Encrypt-Salt",
 *     info: "Pair-Setup-Encrypt-Info"
 *   })
 *   const nonce = yield* Nonce.label("PS-Msg05")
 *   return yield* suite.seal({
 *     key,
 *     nonce,
 *     plaintext: new Uint8Array([1, 2, 3]),
 *     associatedData: new Uint8Array()
 *   })
 * })
 * ```
 *
 * @category services
 * @since 0.1.0
 */
export interface Suite {
  readonly [TypeId]: typeof TypeId

  /**
   * HKDF-SHA512 extract-and-expand, RFC 5869, producing one 32-byte key.
   *
   * The salt and info are strings because every one HAP uses is an ASCII
   * constant from the specification — `"Pair-Setup-Encrypt-Salt"`,
   * `"Control-Write-Encryption-Key"` — and they are encoded as UTF-8 bytes, not
   * decoded from hex. Passing the hexadecimal *of* such a string derives a
   * different key that fails only when the far end disagrees.
   *
   * The output length is fixed at 32 rather than being a parameter: it is a
   * ChaCha20-Poly1305 key every time it is called, and a caller free to ask for
   * 16 would produce a key the AEAD rejects.
   */
  hkdfSha512(options: {
    /** The input keying material — an SRP shared secret, or an X25519 one. */
    readonly key: Redacted.Redacted<Uint8Array>
    readonly salt: string
    readonly info: string
  }): Effect.Effect<Redacted.Redacted<Uint8Array>, PlatformError.PlatformError>

  /**
   * Seal a frame with ChaCha20-Poly1305, RFC 8439.
   *
   * Returns the ciphertext with the 16-byte tag appended — HAP's layout, and the
   * reason the return type is named rather than left as bytes.
   */
  seal(options: {
    readonly key: Redacted.Redacted<Uint8Array>
    readonly nonce: Nonce.Nonce
    readonly plaintext: Uint8Array
    /**
     * Authenticated but not encrypted. Required rather than optional: the
     * control channel authenticates each frame's two-byte length prefix this
     * way, and an optional field is the one people forget. Pass an empty array
     * for the pairing messages, which have none.
     */
    readonly associatedData: Uint8Array
  }): Effect.Effect<CiphertextWithTag, PlatformError.PlatformError>

  /**
   * Open a frame sealed by {@link Suite.seal}.
   *
   * Fails with `ForgedFrame` when the tag does not verify — the frame was
   * altered, or the two ends disagree about the key, the nonce or the associated
   * data. That is a protocol event and not a broken host, which is why it has
   * its own error rather than arriving as a `PlatformError`.
   */
  open(options: {
    readonly key: Redacted.Redacted<Uint8Array>
    readonly nonce: Nonce.Nonce
    /** Ciphertext with the tag appended: at least 16 bytes. */
    readonly ciphertextAndTag: CiphertextWithTag
    readonly associatedData: Uint8Array
  }): Effect.Effect<Uint8Array, PlatformError.PlatformError | ForgedFrame>

  /**
   * The Ed25519 public key for a 32-byte seed.
   *
   * Long-term identity: a controller keeps one of these pairs for its whole
   * life, and an accessory remembers the public half against a pairing
   * identifier. Regenerating it un-pairs every device that trusted it.
   */
  ed25519PublicKey(
    privateKey: Redacted.Redacted<Uint8Array>
  ): Effect.Effect<Uint8Array, PlatformError.PlatformError>

  /** Sign with Ed25519. The signature is 64 bytes; RFC 8032, PureEdDSA. */
  ed25519Sign(options: {
    readonly privateKey: Redacted.Redacted<Uint8Array>
    readonly message: Uint8Array
  }): Effect.Effect<Uint8Array, PlatformError.PlatformError>

  /**
   * Verify an Ed25519 signature.
   *
   * Answers `false` for a signature that does not verify — that is a normal
   * answer, not a failure, because pair-setup's whole purpose is to ask the
   * question about a key it has never seen. It fails when the platform cannot
   * perform the check at all, and when the key or signature is not the length
   * Ed25519 defines: 63 bytes is not a signature that can be false, it is a
   * decoding bug upstream, and returning `false` for it would hide that.
   */
  ed25519Verify(options: {
    readonly publicKey: Uint8Array
    readonly message: Uint8Array
    readonly signature: Uint8Array
  }): Effect.Effect<boolean, PlatformError.PlatformError>

  /** The X25519 public key for a 32-byte scalar, RFC 7748. */
  x25519PublicKey(
    privateKey: Redacted.Redacted<Uint8Array>
  ): Effect.Effect<Uint8Array, PlatformError.PlatformError>

  /**
   * The X25519 shared secret, RFC 7748.
   *
   * Fails when the peer's key is one of the low-order points that drive the
   * shared secret to zero regardless of our scalar. A caller must not paper over
   * that: accepting a zero secret means a peer chooses the session key on its
   * own, and both ends then agree perfectly on a key an attacker also holds.
   */
  x25519SharedSecret(options: {
    readonly privateKey: Redacted.Redacted<Uint8Array>
    readonly publicKey: Uint8Array
  }): Effect.Effect<Redacted.Redacted<Uint8Array>, PlatformError.PlatformError>

  /**
   * A fresh Ed25519 identity.
   *
   * Derived from random bytes rather than from a platform key generator, so a
   * layer that fixes the randomness fixes the identity, and a pairing exchange
   * becomes a reproducible test.
   */
  readonly ed25519KeyPair: Effect.Effect<KeyPair, PlatformError.PlatformError>

  /**
   * A fresh X25519 pair for one pair-verify exchange.
   *
   * Ephemeral: generate one per exchange and drop it afterwards. Reusing it
   * costs the forward secrecy that is the only reason pair-verify does a
   * Diffie-Hellman at all.
   */
  readonly x25519KeyPair: Effect.Effect<KeyPair, PlatformError.PlatformError>
}

/**
 * Service tag for the HAP cryptographic suite.
 *
 * **When to use**
 *
 * Take it from context wherever pairing or session framing needs a primitive.
 * Provide `NodeSuite.layer` at the edge of a program, beside `NodeCrypto.layer`
 * — which it depends on for its random bytes.
 *
 * @see {@link make} for building the service from its primitives
 *
 * @category services
 * @since 0.1.0
 */
export const Suite: Context.Service<Suite, Suite> = Context.Service("@castcli/airplay/Suite")

/**
 * The runtime marker carried by every `Suite`.
 *
 * @category type ids
 * @since 0.1.0
 */
export const SuiteTypeId: typeof TypeId = TypeId
