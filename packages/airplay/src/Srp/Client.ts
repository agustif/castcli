/**
 * The sender's side of the exchange — this tool, pairing with a television.
 *
 * Apple's vectors carry no client private value, so nothing here can be checked
 * against them directly. It is checked instead by agreement: run this against
 * `Server`, which *is* checked against the vectors, and require that both reach
 * the same S, the same M1 and the same M2. The two derivations share no
 * arithmetic — one starts from a stored verifier, the other from a typed PIN —
 * so agreement is not something a common bug could produce.
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
import { fromPassword } from "./Premaster/index.ts"
import { equal, m1 as proveM1, m2 as proveM2 } from "./Proof/index.ts"
import { scrambler } from "./Scrambler.ts"
import { sessionKey } from "./SessionKey.ts"
import { privateKey as passwordKey } from "./Verifier/index.ts"

/**
 * The client's half of a completed exchange, pending the accessory's answer.
 *
 * **Details**
 *
 * `sessionKey` is available here, before M2 has been checked, and that is a
 * genuine difference from the server's `Accepted`. It has to be: the client
 * cannot verify M2 until it has sent M1 and received a reply, and it cannot
 * send M1 without having derived K. The asymmetry is in the protocol, not in
 * this code.
 *
 * **Gotchas**
 *
 * Using `sessionKey` before `verifyServer` has succeeded means encrypting to a
 * peer that has not proved it holds the verifier. HomeKit's transient pairing
 * mode does exactly that on purpose, which is why the field is exposed rather
 * than hidden — but a caller doing it by accident has silently dropped the
 * accessory's half of the authentication.
 *
 * @category models
 * @since 0.1.0
 */
export interface Proof {
  /** K. */
  readonly sessionKey: Uint8Array
  /** M1, to send. */
  readonly m1: Uint8Array
  /**
   * Check the accessory's M2.
   *
   * A failure here is not a wrong PIN — the PIN was already accepted, or M1
   * would have been rejected. It means the peer could not prove it holds the
   * verifier, which is an impostor or a corrupted transcript, and it must not
   * be retried in a loop.
   */
  readonly verifyServer: (m2: Uint8Array) => Effect.Effect<void, ProofRejected>
}

/**
 * A sender partway through one SRP exchange.
 *
 * @category models
 * @since 0.1.0
 */
export interface Client {
  /** A, padded to the group width, ready to put in a TLV. */
  readonly publicKey: Uint8Array
  /**
   * Take the accessory's salt and B, and produce the proof to send.
   *
   * Fails with `InvalidPublicKey` if B is congruent to zero.
   */
  readonly prove: (options: {
    readonly salt: Uint8Array
    readonly serverPublicKey: Uint8Array
  }) => Effect.Effect<Proof, InvalidPublicKey | PlatformError, Crypto.Crypto>
}

/**
 * Begin an exchange from a username and a PIN.
 *
 * **Details**
 *
 * `A = g^a mod N`, which depends on nothing the accessory sends, so it is ready
 * before the first message goes out — which is what lets a sender put A in the
 * same request that asks for the salt.
 *
 * The password is held until `prove` because `x` needs the salt, and the salt
 * arrives with B. It is kept as a plain string rather than `Redacted` because
 * it has to be hashed byte for byte; wrapping it would move the unwrapping one
 * line away rather than removing it. The value is a six-digit setup code
 * displayed on a television for the duration of one pairing, not a stored
 * credential — the stored credential is the verifier, and that one is
 * `Verifier.verifier`'s business.
 *
 * **Gotchas**
 *
 * `privateKey` should be `Option.none()` anywhere real. See `Ephemeral.ts`.
 *
 * @example
 * ```ts
 * const client = make(Group.rfc5054, {
 *   username: "Pair-Setup",
 *   password: "123-45-678",
 *   privateKey: Option.none()
 * }) // Effect<Client, PlatformError, Crypto.Crypto>
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  group: Group.Group,
  options: {
    readonly username: string
    /** The setup code the user read off the screen. */
    readonly password: string
    /** a, pinned for a test; `Option.none()` otherwise. */
    readonly privateKey: Option.Option<Uint8Array>
  }
): Effect.Effect<Client, PlatformError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const k = yield* multiplier(group)
    const a = yield* ephemeral(options.privateKey)
    const clientPublic = modPow(group.generator, a, group.modulus)

    const prove = (exchange: {
      readonly salt: Uint8Array
      readonly serverPublicKey: Uint8Array
    }): Effect.Effect<Proof, InvalidPublicKey | PlatformError, Crypto.Crypto> =>
      Effect.gen(function*() {
        const serverPublic = toBigInt(exchange.serverPublicKey)
        // The mirror of the server's check, and it matters as much. With B ≡ 0
        // the client's base collapses and the derived key stops depending on
        // the password — an accessory that answers with zeros would otherwise
        // learn a key we believe is authenticated.
        yield* serverPublic % group.modulus === 0n
          ? Effect.fail(new InvalidPublicKey({ side: "server" }))
          : Effect.void

        const x = yield* passwordKey({
          username: options.username,
          password: options.password,
          salt: exchange.salt
        })
        const u = yield* scrambler(group, clientPublic, serverPublic)
        const premaster = fromPassword(group, {
          serverPublic,
          multiplier: k,
          passwordKey: x,
          privateKey: a,
          scrambler: u
        })
        const key = yield* sessionKey(group, premaster)
        const m1 = yield* proveM1(group, {
          username: options.username,
          salt: exchange.salt,
          clientPublic,
          serverPublic,
          sessionKey: key
        })
        const expectedM2 = yield* proveM2(group, { clientPublic, m1, sessionKey: key })

        return {
          sessionKey: key,
          m1,
          verifyServer: (m2: Uint8Array) =>
            equal(expectedM2, m2)
              ? Effect.void
              : Effect.fail(new ProofRejected({ proof: "M2" }))
        }
      })

    return { publicKey: Group.encode(group, clientPublic), prove }
  })
