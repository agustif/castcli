/**
 * The message each side signs to introduce its long-term key.
 *
 * `X || pairing identifier || long-term public key`, where `X` is 32 bytes
 * derived from the SRP shared secret. HAP builds it twice under two names —
 * `iOSDeviceInfo` in `HAPPairingPairSetupProcessM5` and `AccessoryDeviceInfo` in
 * `HAPPairingPairSetupGetM6` — and they differ only in the salt and info that
 * derived `X` and in whose identifier and key follow it. The construction is one
 * concept and is written once here.
 *
 * What it is for is worth stating, because it looks like ceremony. The SRP
 * exchange proves both ends knew the setup code; it says nothing about the
 * long-term key each end then hands over. The signature is the join between the
 * two: it can only be produced by something holding the private half of the key
 * it is sent with *and* the shared secret the setup code produced. Without it,
 * anything able to relay the exchange could replace either key with its own and
 * be trusted from then on — and nothing later in the protocol would notice,
 * because every subsequent pair-verify would succeed against the substituted
 * key.
 *
 * @since 0.1.0
 */
import { Redacted } from "effect"

/**
 * The bytes to sign, or to verify a signature over.
 *
 * **Details**
 *
 * Three fields run together with no separators and no lengths, which is
 * unambiguous only because the two that surround the identifier are fixed-width:
 * `X` is always the 32 bytes an HKDF derivation produces and an Ed25519 public
 * key is always 32. The variable-length field is in the middle for that reason,
 * and moving it would let a peer shift bytes between the identifier and the key
 * while producing the same signed message.
 *
 * `x` is `Redacted` on the way in and the result is not, which is the honest
 * shape: the signed message contains the derived secret, so it is not something
 * to log, but it has to be handed to a signature primitive as plain bytes. HAP's
 * own implementation logs it only through `HAPLogSensitiveBufferDebug`.
 *
 * **Gotchas**
 *
 * Which salt and info derived `x` is not visible here and is not checkable
 * later: the two sides use different ones, and building a controller's info with
 * the accessory's `X` produces a signature that verifies against nothing and
 * fails at the far end with no indication of why. The two derivations are named
 * separately in `GeneratedPairing` — `Salt.PairSetupControllerSign` and
 * `Salt.PairSetupAccessorySign` — so that the call site says which it means.
 *
 * @example
 * ```ts
 * import { Effect, Redacted } from "effect"
 * import { GeneratedPairing } from "@castcli/airplay"
 * import { Suite } from "../../Suite/index.ts"
 *
 * const sign = Effect.gen(function*() {
 *   const suite = yield* Suite
 *   const x = yield* suite.hkdfSha512({
 *     key: srpSessionKey,
 *     salt: GeneratedPairing.Salt.PairSetupControllerSign,
 *     info: GeneratedPairing.Info.PairSetupControllerSign
 *   })
 *   return yield* suite.ed25519Sign({
 *     privateKey: identity.keys.privateKey,
 *     message: deviceInfo({ x, identifier, publicKey: identity.keys.publicKey })
 *   })
 * })
 * ```
 *
 * @category encoding
 * @since 0.1.0
 */
export const deviceInfo = (options: {
  /** The 32 bytes HKDF derived from the SRP session key for this side. */
  readonly x: Redacted.Redacted<Uint8Array>
  /** The pairing identifier of the side that will sign this. */
  readonly identifier: Uint8Array
  /** That side's Ed25519 long-term public key. */
  readonly publicKey: Uint8Array
}): Uint8Array => {
  const x = Redacted.value(options.x)
  const info = new Uint8Array(x.length + options.identifier.length + options.publicKey.length)
  info.set(x)
  info.set(options.identifier, x.length)
  info.set(options.publicKey, x.length + options.identifier.length)
  return info
}
