/**
 * The 32 raw bytes inside a SubjectPublicKeyInfo, and the check that it is the
 * curve it was asked for.
 *
 * @since 0.1.0
 */
import { Effect, PlatformError } from "effect"
import * as NodeCrypto from "node:crypto"
import { Sizes } from "../../Suite/Sizes.ts"
import type { Curve } from "./Curve.ts"

/**
 * Strip the envelope from a public key, refusing an envelope that is not this
 * curve's.
 *
 * **Details**
 *
 * The cheap implementation of this is "take the last 32 bytes", which cannot
 * fail and returns 32 plausible bytes from any structure at all. The prefix is
 * compared instead, in full, so a key of the wrong curve is a failure rather
 * than an answer — the two envelopes differ by a single byte of object
 * identifier, and 1.3.101.110 read as 1.3.101.112 is a key agreement key used
 * to sign, which OpenSSL accepts on import and no accessory accepts on the
 * wire.
 *
 * **Gotchas**
 *
 * The length is checked before the prefix, so a truncated structure is reported
 * as the wrong length rather than as the wrong curve.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Ed25519 } from "./Curve.ts"
 * import { exportPublic } from "./exportPublic.ts"
 *
 * declare const key: import("node:crypto").KeyObject
 * const raw: Effect.Effect<Uint8Array, unknown> = exportPublic(Ed25519, key)
 * ```
 *
 * @category destructors
 * @since 0.1.0
 */
export const exportPublic = (
  curve: Curve,
  key: NodeCrypto.KeyObject
): Effect.Effect<Uint8Array, PlatformError.PlatformError> => {
  const failed = (description: string) =>
    Effect.fail(
      PlatformError.systemError({
        module: "Suite",
        method: `${curve.name}.exportPublic`,
        _tag: "InvalidData",
        description
      })
    )
  return Effect.flatMap(
    Effect.try({
      try: () => Uint8Array.from(key.export({ format: "der", type: "spki" })),
      catch: (cause) =>
        PlatformError.systemError({
          module: "Suite",
          method: `${curve.name}.exportPublic`,
          _tag: "Unknown",
          description: `could not export a ${curve.name} public key`,
          cause
        })
    }),
    (der) =>
      der.length !== curve.spkiPrefix.length + Sizes.PUBLIC_KEY
        ? failed(
          `a ${curve.name} SubjectPublicKeyInfo is ${
            curve.spkiPrefix.length + Sizes.PUBLIC_KEY
          } bytes, got ${der.length}`
        )
        : curve.spkiPrefix.every((byte, index) => der[index] === byte)
        ? Effect.succeed(der.slice(curve.spkiPrefix.length))
        : failed(`this key is not ${curve.name} — its algorithm identifier says otherwise`)
  )
}
