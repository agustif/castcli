/**
 * x — the number that stands for the password.
 *
 * Everything downstream that "knows the password" actually knows `x`. The
 * client derives it fresh from the PIN on every exchange; the server never has
 * it, only `g^x`. That asymmetry is the whole point of SRP: a stolen accessory
 * database yields verifiers, and a verifier cannot be replayed as a password.
 *
 * @since 0.1.0
 */
import { Crypto, Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { hash, utf8 } from "../Hash.ts"
import { toBigInt } from "../Math/index.ts"

/**
 * `x = H(salt | H(I | ":" | P))`.
 *
 * **Details**
 *
 * The inner hash binds the username to the password, so the same PIN under two
 * identities gives two different keys; the outer hash binds the result to the
 * salt, so the same PIN on two accessories gives two different verifiers and a
 * precomputed table is worth nothing.
 *
 * Confirmed against Apple's vectors rather than assumed: with `alice`,
 * `password123` and the vector salt, this reproduces the published verifier
 * exactly. That single check settles the whole formula at once — the separator
 * really is a literal colon, the salt really is prepended rather than appended,
 * and the inner digest goes in raw rather than as hex.
 *
 * **Gotchas**
 *
 * The username and password go in as text, not as numbers, so PAD() has nothing
 * to do here — they are hashed exactly as typed. The salt likewise: 16 octets,
 * verbatim. This is the one hash in SRP where padding is not a question, and it
 * is worth saying so, because "pad everything" is as wrong as "pad nothing".
 *
 * Returns a `bigint` because `x` is only ever used as an exponent — `g^x` for
 * the verifier, `a + u*x` for the client's premaster secret. It never goes back
 * on the wire, so it has no canonical byte form to get wrong.
 *
 * @example
 * ```ts
 * const x = privateKey({ username: "alice", password: "password123", salt })
 * // Effect<bigint, PlatformError, Crypto.Crypto>
 * ```
 *
 * @category derivation
 * @since 0.1.0
 */
export const privateKey = (options: {
  readonly username: string
  readonly password: string
  readonly salt: Uint8Array
}): Effect.Effect<bigint, PlatformError, Crypto.Crypto> =>
  hash(utf8(options.username), utf8(":"), utf8(options.password)).pipe(
    Effect.flatMap((identity) => hash(options.salt, identity)),
    Effect.map(toBigInt)
  )
