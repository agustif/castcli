/**
 * `H(N) XOR H(g)` — the first field of M1, and the second half of the padding
 * story.
 *
 * It exists to bind the proof to the group, so a proof computed in one group
 * cannot be replayed in another. It is a separate file from M1 because it is
 * the single place in this implementation where a value is deliberately *not*
 * padded, and that decision needs somewhere to be written down that a reader
 * will find before they "fix" it.
 *
 * @since 0.1.0
 */
import { Crypto, Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type * as Group from "../Group.ts"
import { hash } from "../Hash.ts"
import { fromBigInt } from "../Math/index.ts"

/**
 * `H(N) XOR H(g)`, 64 octets.
 *
 * **Details**
 *
 * Both operands are hashes of the group's numbers in their *minimal*
 * big-endian encoding. For the 3072-bit group that means N is hashed as its
 * natural 384 octets — it begins `FF`, so minimal and padded coincide and
 * nothing is at stake — and `g` is hashed as the single octet `05`.
 *
 * **Gotchas**
 *
 * That single octet is the whole point of this file. The very same generator,
 * in the very same exchange, is hashed *padded to 384 octets* to form the
 * multiplier `k` — see `Multiplier.ts`. Two encodings of one constant, chosen
 * per call site.
 *
 * Neither was guessed. Both were implemented and run against
 * `packages/airplay/vendor/HAPCryptoTest.c`:
 *
 *  - `H(PAD(g))` here: no combination of A and B encodings reproduces the
 *    vector's M1. It was rejected.
 *  - `H(g)` with `g` as one octet: reproduces the vector's M1 exactly. It won.
 *  - and the opposite result holds for `k`, where the padded form is the one
 *    that reproduces B.
 *
 * The reason is lineage, not design. `k` is SRP-6a, defined by RFC 5054 §2.6,
 * which introduced PAD(). M1 is RFC 2945 §3, which predates PAD() and hashes
 * the numbers as written. Apple implemented both specifications faithfully and
 * inherited the inconsistency. An implementation that "tidies" it up produces
 * an M1 a real accessory rejects with an error code that means "wrong PIN".
 *
 * A pure function of the group, and constant per group.
 *
 * @example
 * ```ts
 * const digest = groupDigest(Group.rfc5054)
 * // Effect<Uint8Array, PlatformError, Crypto.Crypto> — 64 octets
 * ```
 *
 * @category derivation
 * @since 0.1.0
 */
export const groupDigest = (
  group: Group.Group
): Effect.Effect<Uint8Array, PlatformError, Crypto.Crypto> =>
  Effect.map(
    Effect.all([hash(fromBigInt(group.modulus)), hash(fromBigInt(group.generator))]),
    ([modulus, generator]) =>
      Uint8Array.from(modulus, (octet, index) => octet ^ (generator[index] ?? 0))
  )
