# Vendored sources

## Apple HomeKit ADK — `HAPPairing.h`, `HAPCrypto.h`, `HAPCryptoTest.c`,
## `HAPPairing.c`, `HAPPairingPairSetup.c`, `HAPPairingPairVerify.c`

From <https://github.com/apple/HomeKitADK>, **Apache License 2.0**, copyright
2015-2019 The HomeKit ADK Contributors. Archived read-only by Apple on
2025-10-28; last commit 2022-07-06.

These are here because they are the authoritative, machine-readable, and
*freely licensed* description of HomeKit pairing — which AirPlay 2
authentication is built on. Three things make them worth vendoring rather than
transcribing:

1. **They are newer than the public specification.** The HAP R2 PDF that Apple
   distributed until roughly 2022 has no `PairResume` method and no `SessionID`
   TLV type; the header has both.
2. **They contain what the PDF omits.** R2 uses the identifier `SessionKey`
   without ever defining how it is derived — the strings
   `Pair-Setup-Encrypt-Salt` and `Pair-Setup-Encrypt-Info` appear nowhere in its
   259 pages. `HAPPairingPairSetup.c` has them, and an implementation that
   guesses simply fails at message five.
3. **`HAPCryptoTest.c` carries SRP `M1`/`M2` test vectors.** Apple's published
   vectors stop at the session key. The proofs are where Apple's SRP departs
   from both RFC 2945 and RFC 5054 — leading zeros stripped in one place and
   padded in another — so these are the only public way to check an
   implementation of the part most likely to be wrong.

A separate, *unlicensed* MFi SDK header circulates with more of the AirPlay
feature-bit names in it. It is deliberately not here: it is leaked proprietary
source, and nothing in this package needs it.

What is generated from these files lives in `src/Generated*.ts`; run
`npm run codegen` to rebuild it.
