/**
 * The four ADK strings pair-verify's cryptography is keyed by.
 *
 * A salt, an info and two nonce labels. None of them is a parameter of the
 * exchange — they are constants of HomeKit, they are what the device on the
 * other end uses, and getting one wrong produces a key or a nonce that is
 * perfectly well formed and agrees with nothing. The failure surfaces as an
 * authentication error several messages later, with nothing pointing at the
 * string, which is why they are gathered here rather than written at the three
 * call sites that need them.
 *
 * They belong in `../GeneratedPairing.ts`, which is derived from the vendored
 * sources by `npm run codegen` and so cannot drift from them. At the time this
 * module was written that generator emitted the TLV vocabulary, the SRP group
 * and the SRP vectors, and not these strings; when it gains them this file
 * becomes three re-exports and nothing else in the directory changes. Until
 * then each constant carries the line of vendored source it was read from, so
 * the claim is checkable in one `sed`.
 *
 * @since 0.1.0
 */

/**
 * The HKDF salts pair-verify uses.
 *
 * **Gotchas**
 *
 * The trailing `-Salt` is part of the value and not decoration: HKDF's extract
 * step keys an HMAC with these bytes, so `"Pair-Verify-Encrypt"` derives a
 * different key that no accessory holds.
 *
 * @example
 * ```ts
 * import * as Vocabulary from "./Vocabulary.ts"
 *
 * Vocabulary.Salt.PairVerifyEncrypt // => "Pair-Verify-Encrypt-Salt"
 * ```
 *
 * @category constants
 * @since 0.1.0
 */
export const Salt = {
  /** `HAPPairingPairVerify.c:495`, the salt for M2's and M3's sub-TLV key. */
  PairVerifyEncrypt: "Pair-Verify-Encrypt-Salt"
} as const

/**
 * The HKDF infos pair-verify uses.
 *
 * @category constants
 * @since 0.1.0
 */
export const Info = {
  /** `HAPPairingPairVerify.c:496`, the info beside the salt above. */
  PairVerifyEncrypt: "Pair-Verify-Encrypt-Info"
} as const

/**
 * The nonce labels of the two encrypted pair-verify messages.
 *
 * **Details**
 *
 * Both messages of one exchange are sealed under the same derived key, so the
 * label is the only thing keeping them from sharing a nonce — and a repeated
 * nonce under ChaCha20 leaks the exclusive-or of the two plaintexts and the
 * Poly1305 one-time key with it. Each is exactly eight characters, which is
 * what `Suite.Nonce.label` requires.
 *
 * @category constants
 * @since 0.1.0
 */
export const Nonce = {
  /** `HAPPairingPairVerify.c:516`, the accessory's sub-TLV in M2. */
  PVMsg02: "PV-Msg02",
  /** `HAPPairingPairVerify.c:772`, the controller's sub-TLV in M3. */
  PVMsg03: "PV-Msg03"
} as const
