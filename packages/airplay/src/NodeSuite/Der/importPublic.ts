/**
 * A raw 32-byte public key, as Node wants it.
 *
 * @since 0.1.0
 */
import { Effect, PlatformError } from "effect"
import * as NodeCrypto from "node:crypto"
import type { Curve } from "./Curve.ts"

/**
 * Wrap 32 raw bytes in SubjectPublicKeyInfo and hand them to Node.
 *
 * **Details**
 *
 * The curve's prefix already contains every length byte the structure needs, so
 * this is a concatenation and not an encoding. The caller guarantees 32 bytes —
 * `Suite.make` checks — which is what makes that true.
 *
 * **Gotchas**
 *
 * Node will build a `KeyObject` from any 32 bytes, including the all-zero key
 * and the other low-order points. It is `crypto.diffieHellman` that rejects
 * those, not this. Nothing here is a validity check on the point.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Ed25519 } from "./Curve.ts"
 * import { importPublic } from "./importPublic.ts"
 *
 * const key = (raw: Uint8Array) => Effect.map(importPublic(Ed25519, raw), (k) => k.type)
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const importPublic = (
  curve: Curve,
  raw: Uint8Array
): Effect.Effect<NodeCrypto.KeyObject, PlatformError.PlatformError> =>
  Effect.try({
    try: () => {
      const der = new Uint8Array(curve.spkiPrefix.length + raw.length)
      der.set(curve.spkiPrefix)
      der.set(raw, curve.spkiPrefix.length)
      return NodeCrypto.createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" })
    },
    catch: (cause) =>
      PlatformError.systemError({
        module: "Suite",
        method: `${curve.name}.importPublic`,
        // InvalidData rather than Unknown: everything that reaches here is the
        // caller's bytes, and the only way this throws with a correct prefix is
        // that they were not a public key.
        _tag: "InvalidData",
        description: `not a ${curve.name} public key`,
        cause
      })
  })
