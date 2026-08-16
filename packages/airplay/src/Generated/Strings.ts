// Generated from the vendored HomeKit ADK. Do not edit.
//
// Source: packages/airplay/vendor/HAPPairingPairSetup.c  (Apache-2.0)
//         packages/airplay/vendor/HAPPairingPairVerify.c
//
// The HKDF salts and info strings, and the nonce labels each encrypted
// pairing message is sealed under. The published specification names
// `SessionKey` without saying how it is derived; these are the derivation, so
// they are read out of Apple's implementation rather than guessed.
//
//   npm run codegen   regenerate from packages/airplay/vendor

import { Schema } from "effect"

/** HKDF salts, named for the derivation each one belongs to. */
export const Salt = {
  PairSetupEncrypt: "Pair-Setup-Encrypt-Salt",
  MFiPairSetup: "MFi-Pair-Setup-Salt",
  SplitSetup: "SplitSetupSalt",
  PairSetupControllerSign: "Pair-Setup-Controller-Sign-Salt",
  PairSetupAccessorySign: "Pair-Setup-Accessory-Sign-Salt",
  Control: "Control-Salt",
  PairVerifyEncrypt: "Pair-Verify-Encrypt-Salt",
  PairVerifyResumeSessionID: "Pair-Verify-ResumeSessionID-Salt",
} as const

export type Salt = typeof Salt[keyof typeof Salt]

/** The same values, as a schema, for decoding a salt that came from elsewhere. */
export const SaltFromWire = Schema.Literals([
  "Pair-Setup-Encrypt-Salt",
  "MFi-Pair-Setup-Salt",
  "SplitSetupSalt",
  "Pair-Setup-Controller-Sign-Salt",
  "Pair-Setup-Accessory-Sign-Salt",
  "Control-Salt",
  "Pair-Verify-Encrypt-Salt",
  "Pair-Verify-ResumeSessionID-Salt",
])

/** HKDF info strings. Paired with a salt; the two are never mixed across rows. */
export const Info = {
  PairSetupEncrypt: "Pair-Setup-Encrypt-Info",
  MFiPairSetup: "MFi-Pair-Setup-Info",
  AccessoryEncryptControl: "AccessoryEncrypt-Control",
  ControllerEncryptControl: "ControllerEncrypt-Control",
  PairSetupControllerSign: "Pair-Setup-Controller-Sign-Info",
  PairSetupAccessorySign: "Pair-Setup-Accessory-Sign-Info",
  ControlRead: "Control-Read-Encryption-Key",
  ControlWrite: "Control-Write-Encryption-Key",
  PairResumeRequest: "Pair-Resume-Request-Info",
  PairVerifyEncrypt: "Pair-Verify-Encrypt-Info",
  PairResumeResponse: "Pair-Resume-Response-Info",
  PairResumeSharedSecret: "Pair-Resume-Shared-Secret-Info",
  PairVerifyResumeSessionID: "Pair-Verify-ResumeSessionID-Info",
} as const

export type Info = typeof Info[keyof typeof Info]

/** The same values, as a schema, for decoding an info string that came from elsewhere. */
export const InfoFromWire = Schema.Literals([
  "Pair-Setup-Encrypt-Info",
  "MFi-Pair-Setup-Info",
  "AccessoryEncrypt-Control",
  "ControllerEncrypt-Control",
  "Pair-Setup-Controller-Sign-Info",
  "Pair-Setup-Accessory-Sign-Info",
  "Control-Read-Encryption-Key",
  "Control-Write-Encryption-Key",
  "Pair-Resume-Request-Info",
  "Pair-Verify-Encrypt-Info",
  "Pair-Resume-Response-Info",
  "Pair-Resume-Shared-Secret-Info",
  "Pair-Verify-ResumeSessionID-Info",
])

/** The label naming each encrypted message of an exchange. */
export const Nonce = {
  PSMsg04: "PS-Msg04",
  PSMsg05: "PS-Msg05",
  PSMsg06: "PS-Msg06",
  PRMsg01: "PR-Msg01",
  PVMsg02: "PV-Msg02",
  PRMsg02: "PR-Msg02",
  PVMsg03: "PV-Msg03",
} as const

export type Nonce = typeof Nonce[keyof typeof Nonce]

/** The same values, as a schema, for decoding a label a device sent. */
export const NonceFromWire = Schema.Literals([
  "PS-Msg04",
  "PS-Msg05",
  "PS-Msg06",
  "PR-Msg01",
  "PV-Msg02",
  "PR-Msg02",
  "PV-Msg03",
])

/**
 * Exactly eight printable ASCII characters, which every HAP nonce label is.
 *
 * The label is the tail of a twelve byte nonce whose leading four bytes are
 * zero, so a seven-character label does not fail — it produces a nonce that is
 * silently misaligned against the one the other end computed, and the only
 * symptom is an authentication tag that does not verify several messages later.
 * ASCII because the label is encoded as UTF-8: a character above U+007F is more
 * than one byte, so eight *characters* would not be eight *bytes*.
 *
 * `NonceFromWire` is the narrower check and this is the wider one. A label that
 * is merely unrecognised is caught there; this catches one that could not be a
 * label at all, including a label this table has not yet been regenerated for.
 */
export const NonceLabel = Schema.String.pipe(
  Schema.check(
    Schema.isLengthBetween(8, 8, {
      message: "a nonce label is 8 characters, such as PS-Msg05"
    }),
    Schema.isPattern(/^[\x20-\x7e]*$/, {
      message: "a nonce label is printable ASCII"
    })
  ),
  Schema.brand("NonceLabel")
)

export type NonceLabel = typeof NonceLabel.Type

/**
 * The SRP user name pair-setup runs under.
 *
 * Fixed, and not the controller's or the accessory's identifier: HomeKit
 * authenticates the *setup code*, so the user name carries no identity and is
 * the same string for every device. It is hashed into `x`, so a different one
 * produces a different verifier and a proof the accessory rejects.
 */
export const SrpUsername = "Pair-Setup"
