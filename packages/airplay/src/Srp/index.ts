/**
 * SRP-6a as HomeKit — and therefore AirPlay — actually implements it.
 *
 * AirPlay 2 authentication is HomeKit pairing, and the first exchange of
 * HomeKit pairing is SRP-6a over RFC 5054's 3072-bit group with SHA-512. The
 * formulas are published; the encodings are not, and Apple's departs from both
 * RFC 2945 and RFC 5054 in the two places implementations get wrong. Those
 * departures are settled here against the only public test vectors that exist,
 * in `packages/airplay/vendor/HAPCryptoTest.c`, and the reasoning is written
 * down beside the code that depends on it — chiefly in `Math/Pad.ts`, which
 * carries the table, and in `Proof/GroupDigest.ts` and `Multiplier.ts`, which
 * are the two call sites that disagree with each other.
 *
 * Both halves are implemented. That is the verification strategy rather than
 * an ambition: the vectors contain a server private value and no client one,
 * so they verify the accessory path completely and the sender path not at all.
 * The sender is checked instead by agreement with a server that reproduces
 * Apple's numbers. It is also what the next phase needs, since an emulated
 * accessory is how the pairing flow gets tested with no television involved.
 *
 * The surface, from the bottom up:
 *
 *   Math       exponentiation, byte order, PAD()
 *   Group      N, g, and the width every PAD() uses
 *   Hash       H(), SHA-512 through Effect's Crypto service
 *   Ephemeral  a and b — random, or pinned so a test can reproduce a vector
 *   Verifier   x from the PIN, v from x
 *   Multiplier k = H(N | PAD(g))
 *   Scrambler  u = H(PAD(A) | PAD(B))
 *   Premaster  S, from the verifier or from the password
 *   SessionKey K = H(PAD(S))
 *   Proof      M1, M2, and how to compare them
 *   Client     the sender
 *   Server     the accessory
 *   Errors     a rejected proof, and a public key that must not be used
 *
 * @since 0.1.0
 */
export * as Client from "./Client.ts"
export * as Ephemeral from "./Ephemeral.ts"
export * as Errors from "./Errors.ts"
export * as Group from "./Group.ts"
export * as Hash from "./Hash.ts"
export * as Math from "./Math/index.ts"
export * as Multiplier from "./Multiplier.ts"
export * as Premaster from "./Premaster/index.ts"
export * as Proof from "./Proof/index.ts"
export * as Scrambler from "./Scrambler.ts"
export * as Server from "./Server.ts"
export * as SessionKey from "./SessionKey.ts"
export * as Verifier from "./Verifier/index.ts"
