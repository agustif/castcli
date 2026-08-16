/**
 * What a controller carries from one message to the next.
 *
 * The steps are pure functions over bytes — nothing here holds a socket, and the
 * thing that eventually runs this over RTSP holds no protocol knowledge — so
 * everything the exchange has learned so far has to travel between them
 * explicitly. That is what this file is. It is also why the exchange is testable
 * at all: a state is an ordinary value, so a test can drive M5 with a state it
 * built itself and never send anything anywhere.
 *
 * There are two states rather than four because M1 learns nothing (it asks a
 * question whose answer is M2) and M6 ends the exchange (what it produces is a
 * `Pairing`, not a state). So the shape is:
 *
 *   m1(options)                        -> request
 *   m3(M2, { pin })                    -> request, {@link Proved}
 *   m5(M4, { state, identity })        -> request, {@link Exchanged}
 *   finish(M6, state)                  -> Pairing
 *
 * @since 0.1.0
 */
import type { Effect, Redacted } from "effect"
import type { Errors } from "../../Srp/index.ts"

/**
 * After M3: the SRP exchange is computed, and the accessory has yet to prove it.
 *
 * **Details**
 *
 * Both fields are what they are because of *when* things happen. A controller
 * derives the SRP session key before it sends M3 — it has to, since the proof it
 * sends is computed over it — and only learns whether the accessory holds the
 * same key when M4 arrives. So the key is carried across a message during which
 * it is not yet known to be shared with anybody, and that is a property of the
 * protocol rather than of this code.
 *
 * **Gotchas**
 *
 * `srpSessionKey` is K, the 64-byte `H(S)`, not the premaster secret S and not
 * the 32-byte key the sub-TLVs are sealed under. Everything downstream derives
 * from it through HKDF with a different salt and info each time, and feeding the
 * wrong one of the three in produces bytes that are self-consistent and that no
 * accessory agrees with. It is `Redacted` so that it can go straight into
 * `Suite.hkdfSha512` without being unwrapped, and so that logging a state does
 * not print it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Proved {
  /** K = H(S), the SRP session key. 64 bytes. */
  readonly srpSessionKey: Redacted.Redacted<Uint8Array>
  /**
   * Check the accessory's M2 proof, which arrives in M4.
   *
   * A function rather than the expected proof itself, because it is the one
   * `Srp.Client` already computed and comparing it is a constant-time decision
   * that belongs to that module. Carrying the expected bytes instead would mean
   * this file deciding how to compare two proofs, which is the kind of thing
   * that gets written with `===` on a hex string.
   */
  readonly verifyAccessoryProof: (
    proof: Uint8Array
  ) => Effect.Effect<void, Errors.ProofRejected>
}

/**
 * After M5: the accessory has proved itself, and our own key has been sent.
 *
 * **Details**
 *
 * `srpSessionKey` travels on because M6 needs it again — the accessory's
 * signature is over a value derived from it with a *different* salt and info
 * than the controller's was, so it cannot be pre-derived at M5 without deriving
 * something that would then have to be explained.
 *
 * `identifier` and `publicKey` are ours, kept as the exact bytes that were
 * signed and sent, so that the `Pairing` at the end reports what the accessory
 * stored rather than what a caller passed in a second time.
 *
 * @category models
 * @since 0.1.0
 */
export interface Exchanged {
  /** K again — M6's signature check derives its own value from it. */
  readonly srpSessionKey: Redacted.Redacted<Uint8Array>
  /**
   * The 32-byte ChaCha20-Poly1305 key both sub-TLVs are sealed under.
   *
   * Derived once at M5 from K with `Pair-Setup-Encrypt-Salt` and
   * `Pair-Setup-Encrypt-Info`, and used in both directions: M5 outbound under
   * nonce `PS-Msg05`, M6 inbound under `PS-Msg06`. The two directions share a
   * key and are kept apart by the nonce alone, which is why the nonces are
   * constants of the protocol and not something either end chooses.
   */
  readonly encryptionKey: Redacted.Redacted<Uint8Array>
  /** This controller's pairing identifier, as the bytes M5 sent. */
  readonly identifier: Uint8Array
  /** This controller's Ed25519 long-term public key, as M5 sent it. */
  readonly publicKey: Uint8Array
}
