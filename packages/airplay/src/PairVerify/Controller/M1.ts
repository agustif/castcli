/**
 * M1 — asking the accessory to start pair-verify.
 *
 * The first message of pair-verify: state and our ephemeral public key.
 * No PIN, no SRP — just Curve25519 key exchange and Ed25519 signatures.
 *
 * @since 0.1.0
 */
import { Effect, Option, Redacted, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { TlvType } from "../../Generated/index.ts"
import { Items } from "../../Tlv8/index.ts"
import { keyPair } from "../Ephemeral/KeyPair.ts"
import type { Suite } from "../../Suite/index.ts"

/** The State byte of the first message. */
const STATE = 1

/**
 * The first request: State 1 and our ephemeral public key.
 *
 * **Details**
 *
 * Returns both the request bytes and the ephemeral key pair, which M3 will need
 * to derive the shared secret and verify the accessory's signature.
 *
 * **Gotchas**
 *
 * The ephemeral key pair is generated fresh for each exchange unless pinned
 * for testing. Reusing ephemeral keys across sessions costs forward secrecy.
 *
 * @example
 * ```ts
 * import { Effect, Option } from "effect"
 *
 * const { request, ephemeralKeys } = yield* m1({ ephemeral: Option.none() })
 * // send `request`, keep `ephemeralKeys` for m3
 * ```
 *
 * @category messages
 * @since 0.1.0
 */
export const m1 = (options: {
  /** Ephemeral private key, or Option.none() to generate fresh. */
  readonly ephemeral: Option.Option<Uint8Array>
}): Effect.Effect<
  { readonly request: Uint8Array; readonly ephemeralKeys: { readonly publicKey: Uint8Array; readonly privateKey: Uint8Array } },
  PlatformError | Schema.SchemaError,
  Suite
> =>
  Effect.gen(function*() {
    const ephemeralKeyPair = yield* keyPair(options.ephemeral)
    
    const request = yield* Schema.encodeEffect(Items)([
      { type: TlvType.State, value: Uint8Array.of(STATE) },
      { type: TlvType.PublicKey, value: ephemeralKeyPair.publicKey }
    ])

    return {
      request,
      ephemeralKeys: {
        publicKey: ephemeralKeyPair.publicKey,
        privateKey: new Uint8Array(Redacted.value(ephemeralKeyPair.privateKey))
      }
    }
  })
