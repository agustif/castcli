/**
 * M1 — the client proving it knew the password.
 *
 * This is the value the published SRP specifications do not pin down. RFC 5054
 * stops at the session key and hands the proof to TLS's own Finished message;
 * RFC 2945 defines M1 but over SHA-1 and a different group. Apple's is RFC
 * 2945's formula with SHA-512 and the 3072-bit group, and the only public
 * evidence of that combination is the vector in
 * `packages/airplay/vendor/HAPCryptoTest.c`.
 *
 * @since 0.1.0
 */
import { Crypto, Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as Group from "../Group.ts"
import { hash, utf8 } from "../Hash.ts"
import { groupDigest } from "./GroupDigest.ts"

/**
 * `M1 = H( H(N) XOR H(g) | H(I) | salt | PAD(A) | PAD(B) | K )`.
 *
 * **Details**
 *
 * Six fields, and each one is there to bind the proof to something: the group,
 * the identity, the salt that made this verifier, both public values, and the
 * key both sides derived. Change any of them and M1 changes, which is what
 * makes a replay from another exchange useless.
 *
 * The username is hashed *before* being concatenated, and that is not
 * decoration. It is the only variable-length field in the list, and these
 * fields run together with no separators and no lengths; hashing it first turns
 * it into a fixed 64 octets, so a username ending in the first octets of a salt
 * cannot be confused for a shorter username and a different salt.
 *
 * Reproduces Apple's vector exactly for `alice` / `password123`.
 *
 * **Gotchas**
 *
 * `sessionKey` is K — `H(S)` — not the premaster secret S, and not the SRP-6a
 * multiplier, which the vector file also calls `k`. Passing S produces a proof
 * that is stable, self-consistent, agreed on by any second implementation
 * making the same mistake, and rejected by every accessory. `SessionKey.ts`
 * records how the vector settles which is which.
 *
 * A and B are padded to the group width; `g` inside `H(N) XOR H(g)` is not.
 * `GroupDigest.ts` is where that asymmetry is argued.
 *
 * @example
 * ```ts
 * const proof = m1(Group.rfc5054, {
 *   username: "Pair-Setup", salt, clientPublic: A, serverPublic: B, sessionKey: K
 * }) // Effect<Uint8Array, PlatformError, Crypto.Crypto> — 64 octets
 * ```
 *
 * @category proofs
 * @since 0.1.0
 */
export const m1 = (
  group: Group.Group,
  options: {
    readonly username: string
    readonly salt: Uint8Array
    readonly clientPublic: bigint
    readonly serverPublic: bigint
    /** K, the session key — not S, and not the multiplier. */
    readonly sessionKey: Uint8Array
  }
): Effect.Effect<Uint8Array, PlatformError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const binding = yield* groupDigest(group)
    const identity = yield* hash(utf8(options.username))
    return yield* hash(
      binding,
      identity,
      options.salt,
      Group.encode(group, options.clientPublic),
      Group.encode(group, options.serverPublic),
      options.sessionKey
    )
  })
