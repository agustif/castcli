/**
 * A raw 32-byte private key, as Node wants it.
 *
 * @since 0.1.0
 */
import { Effect, PlatformError, Redacted } from "effect"
import * as NodeCrypto from "node:crypto"
import type { Curve } from "./Curve.ts"

/**
 * Wrap 32 raw bytes in PrivateKeyInfo and hand them to Node.
 *
 * **Details**
 *
 * For Ed25519 those 32 bytes are the *seed*, not the expanded scalar: RFC 8032
 * derives the scalar and the nonce prefix by hashing the seed, and Node's key
 * import expects the seed. For X25519 they are the scalar, unclamped — clamping
 * happens inside the scalar multiplication, which is why RFC 7748's test vectors
 * can state a private key whose bits are not yet cleared.
 *
 * The key stays `Redacted` up to this line so that it cannot be logged on the
 * way here. `Redacted.value` is called once, inside the effect, and the raw
 * bytes go straight into a `KeyObject`, which does not print its contents.
 *
 * @example
 * ```ts
 * import { Effect, Redacted } from "effect"
 * import { X25519 } from "./Curve.ts"
 * import { importPrivate } from "./importPrivate.ts"
 *
 * const key = (raw: Uint8Array) =>
 *   Effect.map(importPrivate(X25519, Redacted.make(raw)), (k) => k.type)
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const importPrivate = (
  curve: Curve,
  raw: Redacted.Redacted<Uint8Array>
): Effect.Effect<NodeCrypto.KeyObject, PlatformError.PlatformError> =>
  Effect.try({
    try: () => {
      const bytes = Redacted.value(raw)
      const der = new Uint8Array(curve.pkcs8Prefix.length + bytes.length)
      der.set(curve.pkcs8Prefix)
      der.set(bytes, curve.pkcs8Prefix.length)
      return NodeCrypto.createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" })
    },
    catch: (cause) =>
      PlatformError.systemError({
        module: "Suite",
        method: `${curve.name}.importPrivate`,
        _tag: "InvalidData",
        // Deliberately says nothing about the bytes. A description that quoted
        // the length or a prefix of a private key would put it in a log.
        description: `not a ${curve.name} private key`,
        cause
      })
  })
