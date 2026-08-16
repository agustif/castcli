/**
 * K — the shared key the exchange exists to produce.
 *
 * The premaster secret S is a group element and is never used as key material
 * directly: it is 3072 bits with structure, and the bits are not uniform. K is
 * its hash, and it is K that both proofs are computed over and K that the rest
 * of HomeKit pairing feeds into HKDF.
 *
 * @since 0.1.0
 */
import { Crypto, Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as Group from "./Group.ts"
import { hash } from "./Hash.ts"

/**
 * `K = H(PAD(S))`, 64 octets.
 *
 * **Details**
 *
 * Apple's vector settles this one directly, and settles a second thing on the
 * way. The vector array named `k` in `HAPCryptoTest.c` is 64 octets and is
 * produced by `HAP_srp_session_key(_k, S)` — it is *this* value, not the
 * SRP-6a multiplier, which is also a 64-octet SHA-512 output and which the
 * literature also calls `k`. The two are unrelated, and reading the vector as
 * the multiplier gives an implementation that fails in a way that points at the
 * wrong function entirely. Checking `H(S)` against it confirms the reading;
 * checking `H(N | PAD(g))` against it does not match, which confirms it the
 * other way round.
 *
 * S is padded to the group width for the same reason as everywhere else — it is
 * a value modulo N, written into `uint8_t s[SRP_PREMASTER_SECRET_BYTES]` in
 * `HAPCrypto.h`. The vector's S begins with `f1`, so it cannot distinguish
 * padded from minimal on its own; the fixed-width buffer does.
 *
 * **Gotchas**
 *
 * K, not S, is what everything downstream wants. Handing S to HKDF would be
 * wrong in a way that still produces bytes and still agrees with a second
 * implementation that made the same mistake — which is how this class of bug
 * survives an interoperability test between two copies of itself.
 *
 * @example
 * ```ts
 * const K = sessionKey(Group.rfc5054, premasterSecret)
 * // Effect<Uint8Array, PlatformError, Crypto.Crypto> — 64 octets
 * ```
 *
 * @category derivation
 * @since 0.1.0
 */
export const sessionKey = (
  group: Group.Group,
  premaster: bigint
): Effect.Effect<Uint8Array, PlatformError, Crypto.Crypto> =>
  hash(Group.encode(group, premaster))
