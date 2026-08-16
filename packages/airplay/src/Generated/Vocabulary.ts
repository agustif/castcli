// Generated from the vendored HomeKit ADK. Do not edit.
//
// Source: packages/airplay/vendor/HAPPairing.h  (Apache-2.0)
//
// AirPlay 2 authentication is HomeKit pairing. These numbers go on the wire
// and a device answers a wrong one with an error nobody can look up, so they
// are derived from Apple's own header rather than transcribed.
//
//   npm run codegen   regenerate from packages/airplay/vendor

import { Schema } from "effect"

/** Item types in a pairing TLV8 payload. */
export const TlvType = {
  Method: 0,
  Identifier: 1,
  Salt: 2,
  PublicKey: 3,
  Proof: 4,
  EncryptedData: 5,
  State: 6,
  Error: 7,
  RetryDelay: 8,
  Certificate: 9,
  Signature: 10,
  Permissions: 11,
  FragmentData: 12,
  FragmentLast: 13,
  SessionID: 14,
  Flags: 19,
  Separator: 255,
} as const

export type TlvType = typeof TlvType[keyof typeof TlvType]

/** The same values, as a schema, for decoding what a device sent. */
export const TlvTypeFromWire = Schema.Literals([
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  19,
  255,
])

/** Which pairing exchange a request begins. */
export const PairingMethod = {
  PairSetup: 0,
  PairSetupWithAuth: 1,
  PairVerify: 2,
  AddPairing: 3,
  RemovePairing: 4,
  ListPairings: 5,
  PairResume: 6,
} as const

export type PairingMethod = typeof PairingMethod[keyof typeof PairingMethod]

/** The same values, as a schema, for decoding what a device sent. */
export const PairingMethodFromWire = Schema.Literals([
  0,
  1,
  2,
  3,
  4,
  5,
  6,
])

/** How a device declines. `Authentication` is a wrong PIN. */
export const PairingError = {
  Unknown: 1,
  Authentication: 2,
  Backoff: 3,
  MaxPeers: 4,
  MaxTries: 5,
  Unavailable: 6,
  Busy: 7,
} as const

export type PairingError = typeof PairingError[keyof typeof PairingError]

/** The same values, as a schema, for decoding what a device sent. */
export const PairingErrorFromWire = Schema.Literals([
  1,
  2,
  3,
  4,
  5,
  6,
  7,
])

/** Modifiers on pair-setup. `Transient` stops after M4. */
export const PairingFlag = {
  Transient: 16,
  Split: 16777216,
} as const

export type PairingFlag = typeof PairingFlag[keyof typeof PairingFlag]

/** The same values, as a schema, for decoding what a device sent. */
export const PairingFlagFromWire = Schema.Literals([
  16,
  16777216,
])
