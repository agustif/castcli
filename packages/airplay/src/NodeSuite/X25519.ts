/**
 * X25519 on Node: the pair-verify key exchange.
 *
 * @since 0.1.0
 */
import { Effect, PlatformError, Redacted } from "effect"
import * as NodeCrypto from "node:crypto"
import type { Suite } from "../Suite/Service.ts"
import * as Der from "./Der/index.ts"

/**
 * The public key belonging to a scalar.
 *
 * **Details**
 *
 * The scalar is not clamped before import. RFC 7748 clamps inside the scalar
 * multiplication — clear the low three bits, clear the top bit, set the second
 * from the top — so any 32 bytes are a valid private key and two scalars that
 * differ only in the cleared bits give the same public key. This is what lets
 * the RFC's own test vectors state a private key verbatim and expect a
 * particular public key back, and it is the check in `X25519.test.ts`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const x25519PublicKey: Suite["x25519PublicKey"] = (privateKey) =>
  Effect.flatMap(
    Der.importPrivate(Der.X25519, privateKey),
    (key) =>
      Effect.flatMap(
        Effect.try({
          try: () => NodeCrypto.createPublicKey(key),
          catch: (cause) =>
            PlatformError.systemError({
              module: "Suite",
              method: "x25519PublicKey",
              _tag: "Unknown",
              description: "could not derive an X25519 public key",
              cause
            })
        }),
        (publicKey) => Der.exportPublic(Der.X25519, publicKey)
      )
  )

/**
 * The shared secret both ends compute.
 *
 * **Details**
 *
 * Fails, rather than returning 32 zero bytes, when the peer sends one of the
 * low-order points. Node refuses the derivation and that refusal is passed
 * through deliberately: a zero shared secret means the peer chose the session
 * key unilaterally, both ends then agree on it perfectly, and every frame
 * afterwards is readable by anyone who noticed. RFC 7748 section 6.1 leaves the
 * check optional for Diffie-Hellman; for an authenticated exchange like
 * pair-verify it is not optional, because the failure is silent.
 *
 * The result is `Redacted` because it is fed straight into HKDF, and a log line
 * containing it is a log line containing the session key.
 *
 * **Gotchas**
 *
 * The secret is not a key. HAP always runs it through HKDF with a named salt and
 * info before it encrypts anything; using the raw 32 bytes as a ChaCha20 key
 * would interoperate with nothing and would reuse the same key for both
 * directions.
 *
 * @category constructors
 * @since 0.1.0
 */
export const x25519SharedSecret: Suite["x25519SharedSecret"] = ({ privateKey, publicKey }) =>
  Effect.flatMap(
    Effect.all([
      Der.importPrivate(Der.X25519, privateKey),
      Der.importPublic(Der.X25519, publicKey)
    ]),
    ([ours, theirs]) =>
      Effect.try({
        try: () =>
          Redacted.make(
            Uint8Array.from(NodeCrypto.diffieHellman({ privateKey: ours, publicKey: theirs }))
          ),
        catch: (cause) =>
          PlatformError.systemError({
            module: "Suite",
            method: "x25519SharedSecret",
            // The peer's key is data that arrived over the wire, and this is the
            // one thing about it that can be wrong.
            _tag: "InvalidData",
            description:
              "the peer's X25519 public key has small order — the shared secret would be zero whatever our key is",
            cause
          })
      })
  )
