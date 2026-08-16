/**
 * Ed25519 on Node: long-term identity.
 *
 * Node signs and verifies with `KeyObject`s and HAP carries 32 raw bytes, so
 * every function here is a DER import followed by one call. The import is in
 * `Der/`, where both curves share it; what is left in this file is the part that
 * is genuinely about signatures.
 *
 * @since 0.1.0
 */
import { Effect, PlatformError } from "effect"
import * as NodeCrypto from "node:crypto"
import type { Suite } from "../Suite/Service.ts"
import * as Der from "./Der/index.ts"

/**
 * The public key belonging to a seed.
 *
 * **Details**
 *
 * Node derives it by importing the private key and asking for the public one,
 * which is the same computation RFC 8032 describes: hash the seed, clamp the
 * lower half, multiply the base point. There is no separate "derive" call
 * because a `KeyObject` for a private key already knows its public half.
 *
 * **When to use**
 *
 * To publish a controller's identity, and to check a stored pairing: an identity
 * whose public key no longer matches its seed is a corrupted store, and this is
 * how that is noticed rather than discovered at the far end of a pairing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const ed25519PublicKey: Suite["ed25519PublicKey"] = (privateKey) =>
  Effect.flatMap(
    Der.importPrivate(Der.Ed25519, privateKey),
    (key) =>
      Effect.flatMap(
        Effect.try({
          try: () => NodeCrypto.createPublicKey(key),
          catch: (cause) =>
            PlatformError.systemError({
              module: "Suite",
              method: "ed25519PublicKey",
              _tag: "Unknown",
              description: "could not derive an Ed25519 public key",
              cause
            })
        }),
        (publicKey) => Der.exportPublic(Der.Ed25519, publicKey)
      )
  )

/**
 * Sign a message.
 *
 * **Details**
 *
 * The algorithm argument to `crypto.sign` is `null`, which is not an oversight:
 * Ed25519 is PureEdDSA, it hashes the message itself as part of signing, and
 * naming a digest here would ask Node to pre-hash — producing a signature over
 * the hash rather than the message, which no verifier will accept.
 *
 * HAP signs short structures — a pairing identifier concatenated with two public
 * keys — so there is no streaming form and none is wanted.
 *
 * @category constructors
 * @since 0.1.0
 */
export const ed25519Sign: Suite["ed25519Sign"] = ({ message, privateKey }) =>
  Effect.flatMap(
    Der.importPrivate(Der.Ed25519, privateKey),
    (key) =>
      Effect.try({
        try: () => Uint8Array.from(NodeCrypto.sign(null, message, key)),
        catch: (cause) =>
          PlatformError.systemError({
            module: "Suite",
            method: "ed25519Sign",
            _tag: "Unknown",
            description: "could not sign with Ed25519",
            cause
          })
      })
  )

/**
 * Check a signature.
 *
 * **Details**
 *
 * Returns the answer rather than failing on a bad signature, because during
 * pair-setup a bad signature is the expected outcome of an impostor and the
 * caller has a specific reply to send. `crypto.verify` returns a boolean for the
 * same reason and throws only when it cannot perform the check at all.
 *
 * **Gotchas**
 *
 * A `false` here means "this key did not sign this message". It does not mean
 * the message was tampered with, and it does not identify which of the key, the
 * message and the signature is the odd one out — the commonest cause in practice
 * is that the two ends concatenated the signed structure differently.
 *
 * @category constructors
 * @since 0.1.0
 */
export const ed25519Verify: Suite["ed25519Verify"] = ({ message, publicKey, signature }) =>
  Effect.flatMap(
    Der.importPublic(Der.Ed25519, publicKey),
    (key) =>
      Effect.try({
        try: () => NodeCrypto.verify(null, message, key, signature),
        catch: (cause) =>
          PlatformError.systemError({
            module: "Suite",
            method: "ed25519Verify",
            _tag: "Unknown",
            description: "could not check an Ed25519 signature",
            cause
          })
      })
  )
