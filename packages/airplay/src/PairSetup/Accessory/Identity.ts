/**
 * Who the accessory says it is: a pairing identifier and a long-term Ed25519 key.
 *
 * The two travel together because they only mean anything together. What M6
 * signs is the identifier *concatenated with* the public key, and what the
 * controller stores afterwards is the pair — so an accessory that regenerates
 * its key while keeping its identifier is, to every controller that ever paired
 * with it, an impostor claiming a name it knows. Keeping them in one value means
 * the mismatch cannot be constructed by passing two arguments in the wrong
 * order, which is the form the mistake actually takes.
 *
 * @since 0.1.0
 */
import { Effect } from "effect"
import type { Redacted } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { KeyPair } from "../../Suite/index.ts"
import { Suite } from "../../Suite/index.ts"

/**
 * An accessory's permanent identity.
 *
 * **Details**
 *
 * `pairingId` is a string because the accessory chooses it and HAP's own choice
 * is ASCII: the ADK writes `HAPDeviceIDGetAsString`, which is the device ID
 * formatted as `AA:BB:CC:DD:EE:FF`. It is encoded as UTF-8 exactly once, on its
 * way into the signature and the sub-TLV, and never decoded — which is the
 * opposite of the controller's identifier, arriving from the wire as bytes that
 * may not be text at all. See `Pairing.ts`, where that asymmetry is the reason
 * the field there is a `Uint8Array`.
 *
 * **Gotchas**
 *
 * `keys` must be an *Ed25519* pair. `Suite.x25519KeyPair` produces a value of
 * exactly the same shape whose signatures no controller will accept, and the
 * type system cannot tell them apart — `KeyPair` deliberately does not record
 * which algorithm it belongs to.
 *
 * @category models
 * @since 0.1.0
 */
export interface Identity {
  /** The accessory's pairing identifier, at most 36 bytes once encoded. */
  readonly pairingId: string
  /** The long-term Ed25519 pair. The public half is what M6 hands over. */
  readonly keys: KeyPair
}

/**
 * An identity from a pairing identifier and a 32-byte Ed25519 seed.
 *
 * **Details**
 *
 * The public half is derived rather than supplied, so the two halves cannot
 * disagree. That failure is worth designing out: a mismatched pair produces an
 * M6 that decrypts perfectly and whose signature does not verify, and the
 * controller reports it as an authentication failure — which is what it also
 * reports for a mistyped setup code, four messages earlier.
 *
 * **When to use**
 *
 * In a test, with a fixed seed, which is what makes an exchange reproducible.
 * In production the seed comes from `Suite.ed25519KeyPair` once and is stored;
 * generating a new one on each start un-pairs every controller that trusted the
 * old one.
 *
 * @example
 * ```ts
 * import { Effect, Redacted } from "effect"
 * import { fromSeed } from "./Identity.ts"
 *
 * const identity = fromSeed({
 *   pairingId: "AA:BB:CC:DD:EE:FF",
 *   seed: Redacted.make(new Uint8Array(32).fill(7))
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromSeed = (options: {
  readonly pairingId: string
  readonly seed: Redacted.Redacted<Uint8Array>
}): Effect.Effect<Identity, PlatformError, Suite> =>
  Effect.gen(function*() {
    const suite = yield* Suite
    const publicKey = yield* suite.ed25519PublicKey(options.seed)
    return {
      pairingId: options.pairingId,
      keys: { publicKey, privateKey: options.seed }
    }
  })
