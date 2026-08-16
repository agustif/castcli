/**
 * Who this controller is, for as long as it is trusted.
 *
 * Pair-setup does not create trust between two devices; it creates trust between
 * two *identities*, and this is ours. The accessory stores the identifier and
 * the public half against the setup code that was proved, and every later
 * pair-verify authenticates against exactly that record — so this outlives the
 * exchange, the session, and the process. Generating a fresh one per run would
 * mean pairing again on every launch, and would leave the television's pairing
 * list filling up with identities nothing holds the keys for.
 *
 * @since 0.1.0
 */
import type { KeyPair } from "../../Suite/index.ts"

/**
 * The most bytes a pairing identifier may be.
 *
 * **Details**
 *
 * `sizeof(HAPPairingID)` is 36 in `packages/airplay/vendor/HAPPairing.h`, and
 * `HAPPairingPairSetupProcessM5` rejects anything longer with
 * `kHAPError_InvalidData` — which is not an error TLV but an aborted procedure,
 * so a controller that overran it would see the exchange stop with nothing to
 * read. 36 is also exactly the printed length of a UUID, which is what a
 * controller conventionally uses and what the limit was chosen for.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_IDENTIFIER_BYTES = 36

/**
 * A controller's long-term identity: a name, and the key pair that proves it.
 *
 * **Details**
 *
 * `keys` is the suite's `KeyPair` — the Ed25519 pair `Suite.ed25519KeyPair` makes
 * — rather than two fields restated here, so that a key pair from the suite goes
 * in without being taken apart and put back together. The private half is
 * `Redacted`, and it is used exactly once per pairing: to sign the device info
 * in M5.
 *
 * **When to use**
 *
 * Generate one on first run, store both halves, and pass the same value to every
 * `m5` from then on. A caller that stores only the public half can pair but
 * cannot subsequently pair-verify, which fails much later and looks like the
 * television having forgotten the pairing.
 *
 * **Gotchas**
 *
 * `identifier` is a string and is encoded as UTF-8 on the wire, so its length in
 * bytes is not its length in characters — `m5` measures the bytes and refuses an
 * identifier longer than {@link MAX_IDENTIFIER_BYTES}.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Suite } from "../../Suite/index.ts"
 *
 * const fresh = Effect.gen(function*() {
 *   const suite = yield* Suite
 *   const keys = yield* suite.ed25519KeyPair
 *   return { identifier: "0f9b8bd0-8bdf-4c31-9c8b-0c93f4c2f4b1", keys } satisfies Identity
 * })
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface Identity {
  /** What the accessory will know this controller by. UTF-8, at most 36 bytes. */
  readonly identifier: string
  /** The Ed25519 long-term pair. Its public half is the LTPK sent in M5. */
  readonly keys: KeyPair
}
