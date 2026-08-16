/**
 * v — what the accessory stores instead of the password.
 *
 * @since 0.1.0
 */
import { Crypto, Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as Group from "../Group.ts"
import { modPow } from "../Math/index.ts"
import { privateKey } from "./PrivateKey.ts"

/**
 * `v = g^x mod N`, as the octets it is stored and transmitted as.
 *
 * **Details**
 *
 * Returned padded to the group width — 384 octets — rather than minimally
 * encoded. `HAP_srp_verifier` writes into `uint8_t v[SRP_VERIFIER_BYTES]`, a
 * fixed 384-byte buffer, and `HAPCryptoTest.c` contains a test, `test_bn_pad`,
 * whose entire purpose is to fail if an implementation uses OpenSSL's
 * `BN_bn2bin` — the minimal encoding — instead of padding. Apple wrote a test
 * to prohibit the short form; roughly one verifier in 256 has a leading zero
 * byte, and a database storing those short is a database that mostly works.
 *
 * **When to use**
 *
 * Once, when a device is first set up, to produce the value the accessory keeps
 * forever. The server side of an exchange takes this back as an input; the
 * client never sees it. Anything computing it per-exchange has misunderstood
 * what a verifier is for.
 *
 * **Gotchas**
 *
 * This is a stored credential. Anyone holding it can impersonate the
 * *accessory* to a client — SRP protects the password, not the verifier — so it
 * belongs wherever the device's long-term keys belong, and not in a log.
 *
 * @example
 * ```ts
 * const v = verifier(Group.rfc5054, { username: "alice", password: "password123", salt })
 * // Effect<Uint8Array, PlatformError, Crypto.Crypto> — 384 octets
 * ```
 *
 * @category derivation
 * @since 0.1.0
 */
export const verifier = (
  group: Group.Group,
  options: {
    readonly username: string
    readonly password: string
    readonly salt: Uint8Array
  }
): Effect.Effect<Uint8Array, PlatformError, Crypto.Crypto> =>
  Effect.map(
    privateKey(options),
    (x) => Group.encode(group, modPow(group.generator, x, group.modulus))
  )
