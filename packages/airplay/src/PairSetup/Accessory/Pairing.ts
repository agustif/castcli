/**
 * What the accessory learns from a completed pair-setup: one controller's name
 * and its long-term public key.
 *
 * This is the entire product of the exchange. Everything else — the SRP proofs,
 * the derived encryption key, the two signatures — exists to establish that
 * these three fields came from someone holding the setup code, and is discarded
 * when M6 has been sent. Pair-verify, every time the controller reconnects
 * afterwards, uses nothing but this.
 *
 * @since 0.1.0
 */

/**
 * A controller the accessory has agreed to trust.
 *
 * **Details**
 *
 * `identifier` is bytes, not a string, and the difference is load-bearing in a
 * way the accessory's own identifier is not. It arrives from the wire inside an
 * encrypted sub-TLV, it is signed byte for byte as part of iOSDeviceInfo, and
 * pair-verify later looks a pairing up by comparing those same bytes. Decoding
 * it as UTF-8 to store it and encoding it again to compare would be an identity
 * function for every controller Apple ships and a lossy one — U+FFFD in place of
 * each invalid sequence — for anything else, and the symptom is a device that
 * pairs successfully and can never reconnect.
 *
 * `permissions` is the bit HAP writes as `0x01`: this controller is an admin and
 * may add further pairings. The ADK hard-codes it at M5 because the first
 * controller to pair an unpaired accessory is by definition its owner.
 *
 * **Gotchas**
 *
 * Holding one of these is not the same as having verified anything. It is
 * produced only on the path where the controller's signature verified, but the
 * *value* carries no evidence of that — do not construct one from data that
 * arrived some other way and hand it to pair-verify.
 *
 * @example
 * ```ts
 * const pairing: Pairing = {
 *   identifier: new TextEncoder().encode("1a2b3c4d-0000-0000-0000-000000000000"),
 *   publicKey: controllerLtpk,
 *   permissions: ADMIN
 * }
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface Pairing {
  /** The controller's pairing identifier, exactly as it was signed. */
  readonly identifier: Uint8Array
  /** Its long-term Ed25519 public key: 32 bytes. */
  readonly publicKey: Uint8Array
  /** HAP's permissions byte. */
  readonly permissions: number
}

/**
 * The permissions byte HAP gives the controller that performs pair-setup.
 *
 * **Details**
 *
 * `0x01` is "admin". There is no negotiation and no other value at this point in
 * the protocol: pair-setup only ever runs against an unpaired accessory, so the
 * controller that completes it is the one that will be adding the others.
 * Additional pairings arrive later through `AddPairing`, where the permissions
 * byte is a parameter and may be zero.
 *
 * @category constants
 * @since 0.1.0
 */
export const ADMIN = 0x01

/**
 * The longest a controller's pairing identifier may be.
 *
 * **Details**
 *
 * 36 bytes, from `HAPPairingID` in `packages/airplay/vendor/HAPPairing.h`, where
 * a static assertion pins the struct at that size. It is not a coincidental
 * number — it is the length of a hyphenated UUID in ASCII, which is what iOS
 * sends — but it is enforced as a byte count rather than as a shape, because
 * nothing in the protocol says the identifier has to be a UUID.
 *
 * **Gotchas**
 *
 * A longer identifier is rejected rather than truncated. Truncating would store
 * a prefix that no longer matches what was signed, so pair-verify would fail
 * later with nothing pointing back at pair-setup.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_IDENTIFIER_BYTES = 36
