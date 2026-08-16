/**
 * What the six messages were for: two names and two public keys.
 *
 * Everything else pair-setup computes — the SRP proofs, the shared secret, the
 * key the sub-TLVs were sealed under — exists to make this record trustworthy
 * and is then thrown away. Nothing derived from the setup code survives here,
 * which is the point: the code is displayed for one pairing and pair-verify,
 * which is what every later connection uses, never sees it.
 *
 * @since 0.1.0
 */

/**
 * One end of a pairing: who it is, and the key it signs with.
 *
 * **Details**
 *
 * The identifier is bytes rather than a string. HAP writes a UTF-8 device
 * identifier there and the ADK compares the bytes without interpreting them, so
 * decoding to a string would introduce a failure mode — an identifier that is
 * not valid UTF-8 — for a value nothing here needs to read. A caller that wants
 * to display it can decode it and decide for itself what to do with the
 * remainder.
 *
 * @category models
 * @since 0.1.0
 */
export interface Peer {
  /** The pairing identifier, as it went on the wire. At most 36 bytes. */
  readonly identifier: Uint8Array
  /** The Ed25519 long-term public key. 32 bytes. */
  readonly publicKey: Uint8Array
}

/**
 * A completed pairing: each side's identifier and long-term public key.
 *
 * **Details**
 *
 * Both halves are here because both are needed later and for different reasons.
 * The accessory's public key is what verifies its signature in every subsequent
 * pair-verify, and the controller's identifier is what a pair-verify announces
 * so that the accessory can find the record it stored — sending one and
 * remembering the other is enough to make a pairing that cannot be used.
 *
 * **Gotchas**
 *
 * The controller's *private* key is deliberately absent. It came from the
 * `Identity` the caller passed in and it is the caller that has to keep it; a
 * pairing record that carried it would be a long-term secret in a value whose
 * whole purpose is to be written down somewhere.
 *
 * @example
 * ```ts
 * declare const pairing: Pairing
 * new TextDecoder().decode(pairing.accessory.identifier) // => "AA:BB:CC:DD:EE:FF"
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface Pairing {
  /** This device, as the accessory now knows it. */
  readonly controller: Peer
  /** The accessory, as it introduced itself in M6. */
  readonly accessory: Peer
}
