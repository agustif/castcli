/**
 * u — the scrambling parameter, which is what stops a passive eavesdropper.
 *
 * Both sides raise something to a power involving `u`, and `u` is a hash of
 * both public values, so neither side can pick it. If `u` were chosen by the
 * client, it could pick `u = 0`; the server's `S = (A * v^0)^b` then loses the
 * verifier entirely and the password stops being part of the exchange.
 *
 * @since 0.1.0
 */
import { Crypto, Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as Group from "./Group.ts"
import { hash } from "./Hash.ts"
import { toBigInt } from "./Math/index.ts"

/**
 * `u = H(PAD(A) | PAD(B))`.
 *
 * **Details**
 *
 * Both public values are padded to the group width. This is the hash where
 * padding was invented to matter: the two fields are concatenated with nothing
 * between them, so without a fixed width, an A one byte short and a B one byte
 * long produce the same input as the correct pair — the length-extension
 * ambiguity RFC 5054 §2.6 added PAD() to close.
 *
 * Apple's vectors cannot distinguish the padded form from the minimal one here,
 * because their A and B both begin with a non-zero octet. The evidence is
 * `HAPCrypto.h` instead: `HAP_srp_scrambling_parameter` takes
 * `const uint8_t pub_a[SRP_PUBLIC_KEY_BYTES]` and `pub_b[SRP_PUBLIC_KEY_BYTES]`
 * with no lengths beside them, so at that boundary a short encoding cannot even
 * be expressed. `Math/Pad.ts` records the whole argument.
 *
 * **Gotchas**
 *
 * The full 64-byte digest is the number. Some SRP descriptions — and the
 * original SRP-3 paper — truncate `u` to 32 bits; doing that here silently
 * weakens the exchange and produces a premaster secret neither Apple nor this
 * code would recognise. The vector confirms the untruncated form: its `u` is 64
 * octets, matching `SRP_SCRAMBLING_PARAMETER_BYTES`.
 *
 * @example
 * ```ts
 * const u = scrambler(Group.rfc5054, clientPublic, serverPublic)
 * // Effect<bigint, PlatformError, Crypto.Crypto>
 * ```
 *
 * @category derivation
 * @since 0.1.0
 */
export const scrambler = (
  group: Group.Group,
  clientPublic: bigint,
  serverPublic: bigint
): Effect.Effect<bigint, PlatformError, Crypto.Crypto> =>
  Effect.map(
    hash(Group.encode(group, clientPublic), Group.encode(group, serverPublic)),
    toBigInt
  )
