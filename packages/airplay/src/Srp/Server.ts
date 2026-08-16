/**
 * The accessory's side of the exchange — the television, emulated.
 *
 * Built for two reasons, and the first is verification. Apple's vectors carry
 * `salt`, `v`, `b`, `A`, `B`, `u`, `S`, `K`, `M1` and `M2`, and no client
 * private value at all. That set is exactly the server's inputs and outputs, so
 * this half can be checked against numbers a real HomeKit accessory produced,
 * end to end, with nothing assumed. The client half is then checked by
 * agreement against this one — which is as close to hardware-verified as it is
 * possible to get without touching hardware, and touching hardware is
 * forbidden here.
 *
 * The second reason is that the next phase needs it anyway: an emulated
 * accessory is what lets the whole pairing flow be exercised with no television
 * in the room, the same way `packages/emulator/src/DlnaDevice.ts` does for
 * UPnP.
 *
 * @since 0.1.0
 */
import { Crypto, Effect, Option } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ephemeral } from "./Ephemeral.ts"
import { InvalidPublicKey, ProofRejected } from "./Errors.ts"
import * as Group from "./Group.ts"
import { modPow, toBigInt } from "./Math/index.ts"
import { multiplier } from "./Multiplier.ts"
import { fromVerifier } from "./Premaster/index.ts"
import { equal, m1 as proveM1, m2 as proveM2 } from "./Proof/index.ts"
import { scrambler } from "./Scrambler.ts"
import { sessionKey } from "./SessionKey.ts"

/**
 * What a client's proof earns when it is accepted.
 *
 * **Details**
 *
 * Produced only on the success path, so there is no way to read the session key
 * out of a failed exchange. That is why `verify` returns this record rather
 * than the server exposing `sessionKey` as a field: a field would be readable
 * before M1 had been checked, and a caller that read it early would have
 * derived a key with an unauthenticated peer.
 *
 * @category models
 * @since 0.1.0
 */
export interface Accepted {
  /** K. What the rest of HomeKit pairing feeds into HKDF. */
  readonly sessionKey: Uint8Array
  /** M2, to send back, proving the accessory held the verifier. */
  readonly m2: Uint8Array
}

/**
 * An accessory partway through one SRP exchange.
 *
 * **Details**
 *
 * `publicKey` is already computed when the value exists, because B depends on
 * nothing the client sends — which is why an accessory can answer the first
 * request without having seen anything.
 *
 * **Gotchas**
 *
 * Nothing here limits the number of attempts. Calling `verify` repeatedly with
 * guessed proofs is arithmetically harmless and is exactly how a six-digit PIN
 * gets brute-forced; HomeKit's answer is a lockout after three failures, and
 * that belongs in the pairing state machine above this, which is the only layer
 * that knows what "an attempt" means. Stated here because a reader who does not
 * see the counter may assume it is further down.
 *
 * @category models
 * @since 0.1.0
 */
export interface Server {
  /** B, padded to the group width, ready to put in a TLV. */
  readonly publicKey: Uint8Array
  /**
   * Check the client's proof and answer it.
   *
   * Fails with `InvalidPublicKey` if A is congruent to zero — which is not a
   * wrong password but an attack, and must not be reported as one — and with
   * `ProofRejected` if M1 does not match, which is a wrong PIN.
   */
  readonly verify: (options: {
    readonly clientPublicKey: Uint8Array
    readonly m1: Uint8Array
  }) => Effect.Effect<
    Accepted,
    InvalidPublicKey | ProofRejected | PlatformError,
    Crypto.Crypto
  >
}

/**
 * Begin an exchange from a stored verifier.
 *
 * **Details**
 *
 * `B = k*v + g^b mod N`. The `k*v` term is what carries the verifier into the
 * public value; without it the exchange would be plain Diffie-Hellman and the
 * password would play no part.
 *
 * The username is a parameter rather than a constant. For AirPlay it is always
 * the ASCII string `Pair-Setup` — it appears in
 * `packages/airplay/vendor/HAPPairingPairSetup.c` — but Apple's vectors use
 * `alice`, and hard-coding the production value here would make the only test
 * vectors in existence unusable.
 *
 * **Gotchas**
 *
 * `verifier` is the 384-octet stored form, not a password. This function cannot
 * tell the difference between a verifier and any other 384 octets, and a caller
 * that passes the wrong thing gets an exchange that completes on the server
 * side and is rejected by every client.
 *
 * `privateKey` should be `Option.none()` anywhere real. See `Ephemeral.ts`.
 *
 * @example
 * ```ts
 * const server = make(Group.rfc5054, {
 *   username: "Pair-Setup",
 *   salt,
 *   verifier: v,
 *   privateKey: Option.none()
 * }) // Effect<Server, PlatformError, Crypto.Crypto>
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  group: Group.Group,
  options: {
    readonly username: string
    readonly salt: Uint8Array
    /** v, as stored at setup: 384 octets. */
    readonly verifier: Uint8Array
    /** b, pinned for a test; `Option.none()` otherwise. */
    readonly privateKey: Option.Option<Uint8Array>
  }
): Effect.Effect<Server, PlatformError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const k = yield* multiplier(group)
    const b = yield* ephemeral(options.privateKey)
    const v = toBigInt(options.verifier)
    const serverPublic = ((k * v) + modPow(group.generator, b, group.modulus)) %
      group.modulus

    const verify = (proof: {
      readonly clientPublicKey: Uint8Array
      readonly m1: Uint8Array
    }): Effect.Effect<
      Accepted,
      InvalidPublicKey | ProofRejected | PlatformError,
      Crypto.Crypto
    > =>
      Effect.gen(function*() {
        const clientPublic = toBigInt(proof.clientPublicKey)
        // RFC 5054 §2.5.4. With A ≡ 0 the premaster secret is 0 whatever the
        // verifier is, so a peer that never knew the password derives the same
        // key we do and the exchange completes. Checked before anything is
        // derived from it.
        yield* clientPublic % group.modulus === 0n
          ? Effect.fail(new InvalidPublicKey({ side: "client" }))
          : Effect.void

        const u = yield* scrambler(group, clientPublic, serverPublic)
        const premaster = fromVerifier(group, {
          clientPublic,
          verifier: v,
          scrambler: u,
          privateKey: b
        })
        const key = yield* sessionKey(group, premaster)
        const expected = yield* proveM1(group, {
          username: options.username,
          salt: options.salt,
          clientPublic,
          serverPublic,
          sessionKey: key
        })
        yield* equal(expected, proof.m1)
          ? Effect.void
          : Effect.fail(new ProofRejected({ proof: "M1" }))

        // Computed over the M1 that arrived, which the check above has just
        // established is the one we computed. Proving over our own M1 without
        // that check would answer every attempt, correct or not.
        const m2 = yield* proveM2(group, {
          clientPublic,
          m1: proof.m1,
          sessionKey: key
        })
        return { sessionKey: key, m2 }
      })

    return { publicKey: Group.encode(group, serverPublic), verify }
  })
