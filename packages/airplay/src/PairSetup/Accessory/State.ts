/**
 * Where the accessory is in one pair-setup exchange, and what it is carrying.
 *
 * Three states, because there are three requests. A tagged union rather than
 * HAP's `uint8_t state` for one reason that is worth spelling out: the ADK
 * carries `A`, `B`, `b`, `M1`, `K` and `SessionKey` as fixed buffers on the
 * session struct, live from the moment the session exists, so "M5 arrived before
 * M3" reads a session key of zeroes and decrypts against it. That failure is
 * silent — it produces a `ForgedFrame`, four messages from where the mistake
 * was. Here the session key does not *exist* until M4 has accepted the proof,
 * so the same out-of-order message is a match failure at the dispatch, with the
 * two states named in the error.
 *
 * What the states are not is a record of what has been agreed. A completed
 * exchange ends back at {@link AwaitingM1}, exactly as the ADK resets the
 * session after M6, and the pairing it produced lives elsewhere — see
 * `Pairing.ts`. Keeping "which message comes next" separate from "whom do we
 * trust" is what lets an already-paired accessory answer a fresh M1 with
 * `kTLVType_Error = Unavailable` rather than starting an exchange it must not
 * finish.
 *
 * @since 0.1.0
 */
import { Data } from "effect"
import type { Redacted } from "effect"
import type * as Server from "../../Srp/Server.ts"

/**
 * The accessory's position in the exchange.
 *
 * **Details**
 *
 * Each state holds precisely what the *next* message needs and nothing else, so
 * a field being reachable is itself the proof that it has been established.
 *
 * **Gotchas**
 *
 * Both keys in {@link State.AwaitingM5} are derived from the same SRP session
 * key and are not interchangeable. `encryptionKey` is HKDF'd with
 * `Pair-Setup-Encrypt-*` and is what M5 and M6 are sealed under;
 * `srpSessionKey` is K itself, the input to the two *signing* derivations in
 * `Sub/`. Sealing under K, or signing over a value derived from the encryption
 * key, produces messages that are internally consistent and that no real device
 * accepts.
 *
 * @example
 * ```ts
 * import { State } from "./State.ts"
 *
 * const start = State.AwaitingM1()
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export type State = Data.TaggedEnum<{
  /**
   * Nothing has happened, or everything has. The next message must be M1.
   *
   * Also where the machine returns after a refusal — a wrong setup code, a
   * signature that did not verify — because the ADK resets the procedure on
   * every error it reports, and a controller's retry is a new exchange with a
   * new salt and a new `b` rather than a second guess at the same one.
   */
  readonly AwaitingM1: {}

  /**
   * M2 has been sent: the controller has the salt and B. The next message is M3.
   *
   * The SRP server carries `b` and the verifier and will not part with a session
   * key until it has been given a proof it accepts, which is why the exchange
   * itself is held here rather than its ingredients.
   */
  readonly AwaitingM3: { readonly srp: Server.Server }

  /**
   * M4 accepted the proof: the setup code was right. The next message is M5.
   *
   * Reaching this state is the whole of the authentication. What M5 and M6 add
   * is an exchange of long-term identities *over* a channel this state's keys
   * already make private.
   */
  readonly AwaitingM5: {
    /** K, the SRP session key. What the two signing derivations expand. */
    readonly srpSessionKey: Redacted.Redacted<Uint8Array>
    /** The ChaCha20-Poly1305 key M5 and M6 are sealed under. */
    readonly encryptionKey: Redacted.Redacted<Uint8Array>
  }
}>

/**
 * Constructors and matchers for {@link State}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const State = Data.taggedEnum<State>()
