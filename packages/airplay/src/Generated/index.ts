// Generated from the vendored HomeKit ADK. Do not edit.
//
// Source: packages/airplay/vendor/HAPPairing.h  (Apache-2.0)
//         packages/airplay/vendor/HAPPairingPairSetup.c
//         packages/airplay/vendor/HAPPairingPairVerify.c
//         packages/airplay/vendor/HAPCryptoTest.c
//         packages/airplay/vendor/rfc5054.txt
//
// AirPlay 2 authentication is HomeKit pairing. Everything here goes on the
// wire or into a key, and a device answers a wrong value with an error nobody
// can look up — so all of it is derived from Apple's own sources rather than
// transcribed. What is not named below is private to this directory.
//
//   Vocabulary  TLV types, methods, errors, flags
//   Group       the 3072-bit SRP group
//   Vectors     Apple's SRP test vectors
//   Strings     HKDF salts and info strings, and nonce labels
//
//   npm run codegen   regenerate from packages/airplay/vendor

export { Group3072 } from "./Group.ts"
export {
  Info,
  InfoFromWire,
  Nonce,
  NonceFromWire,
  NonceLabel,
  Salt,
  SaltFromWire,
  SrpUsername,
} from "./Strings.ts"
export { SrpVectors } from "./Vectors.ts"
export {
  PairingError,
  PairingErrorFromWire,
  PairingFlag,
  PairingFlagFromWire,
  PairingMethod,
  PairingMethodFromWire,
  TlvType,
  TlvTypeFromWire,
} from "./Vocabulary.ts"
