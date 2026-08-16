/**
 * M3 — the controller's public value and its proof that it knows the code.
 *
 * Reads M2, which is the accessory's SRP salt and public key B, and answers with
 * A and M1. It is the step where the setup code the user typed turns into
 * arithmetic: from here on the code itself is never sent, never stored and never
 * needed again — only the shared secret it produced.
 *
 * All of the SRP lives in `../../Srp`, which is checked against Apple's own
 * vectors. What is here is the wire: which items carry which values, and what to
 * do when the accessory answered with something else.
 *
 * @since 0.1.0
 */
import { type Crypto, Effect, Option, Redacted, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { SrpUsername, TlvType } from "../../Generated/index.ts"
import { Items } from "../../Tlv8/index.ts"
import { Client, type Errors as SrpErrors, Group } from "../../Srp/index.ts"
import type {
  AccessoryRefused,
  MissingItem,
  UnexpectedState,
  WrongSetupCode
} from "../Errors.ts"
import { read, required } from "./Response/index.ts"
import type { Proved } from "./State.ts"

/** The State byte this message answers, and the one it sends. */
const ANSWERING = 2
const STATE = 3

/**
 * Read M2 and produce M3, with the state M5 will need.
 *
 * **Details**
 *
 * `pin` is the setup code exactly as it is displayed on the television, dashes
 * included — `"123-45-678"`, not `"12345678"`. The accessory's verifier was
 * computed over those bytes, so stripping the punctuation produces a different
 * password, a different proof, and an M4 that reports the code as wrong. The
 * generator that builds an accessory's setup info is not among the vendored
 * sources, so that one detail comes from the specification rather than from the
 * code beside it — but it is the mistake to check first when a correct-looking
 * code is rejected.
 *
 * The accessory's public key is required but not checked for length. The ADK
 * strips its leading zero bytes before sending — `HAPPairingPairSetupGetM2`
 * walks `B` forward while it is zero — so a value that ought to be 384 bytes
 * arrives shorter roughly one time in 256, and a controller that insisted on the
 * full width would fail against a real device rarely and unreproducibly. The
 * number is read as a big-endian integer, which makes the stripping invisible.
 *
 * The salt is not length-checked either. It is 16 bytes from every ADK accessory
 * (`SRP_SALT_BYTES`), and it is public input to a hash rather than something a
 * primitive here will choke on, so rejecting another length would be strictness
 * with nothing behind it.
 *
 * A is sent at the full group width, 384 bytes, which is two TLV8 items — the
 * payload codec fragments it. The ADK zero-extends whatever it receives, so the
 * padding is not required of us; sending it is what makes the request bytes
 * identical from one run to the next for a given `a`, which is what the tests
 * pin.
 *
 * **Gotchas**
 *
 * The ephemeral private value `a` comes from `Crypto.randomBytes` through
 * `Srp.Ephemeral`, so this function is not pure and two calls with the same
 * arguments produce different bytes. That is the point of taking `Crypto` from
 * context rather than reaching for a platform generator: a test provides fixed
 * bytes and the whole exchange replays.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 *
 * declare const m2Response: Uint8Array
 * const next = Effect.gen(function*() {
 *   const { request, state } = yield* m3(m2Response, { pin: "123-45-678" })
 *   // send `request`, keep `state` for m5
 *   return state
 * })
 * ```
 *
 * @category messages
 * @since 0.1.0
 */
export const m3 = (
  m2Response: Uint8Array,
  options: {
    /** The setup code as displayed, dashes and all. */
    readonly pin: string
  }
): Effect.Effect<
  { readonly request: Uint8Array; readonly state: Proved },
  | AccessoryRefused
  | MissingItem
  | PlatformError
  | Schema.SchemaError
  | SrpErrors.InvalidPublicKey
  | UnexpectedState
  | WrongSetupCode,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const items = yield* read({ bytes: m2Response, step: "M2", state: ANSWERING })
    const salt = yield* required({
      items,
      step: "M2",
      within: "message",
      type: TlvType.Salt
    })
    const serverPublicKey = yield* required({
      items,
      step: "M2",
      within: "message",
      type: TlvType.PublicKey
    })

    const client = yield* Client.make(Group.rfc5054, {
      username: SrpUsername,
      password: options.pin,
      // Never pinned here. `Srp.Ephemeral` takes an `Option` so that supplying
      // `a` is a deliberate act available to a test; a parameter on this
      // function would make it available to a caller, and a pinned `a` lets
      // anyone holding a recorded transcript derive the session key.
      privateKey: Option.none()
    })
    const proof = yield* client.prove({ salt, serverPublicKey })

    const request = yield* Schema.encodeEffect(Items)([
      { type: TlvType.State, value: Uint8Array.of(STATE) },
      { type: TlvType.PublicKey, value: client.publicKey },
      { type: TlvType.Proof, value: proof.m1 }
    ])

    return {
      request,
      state: {
        // Redacted from here on. It is K, and everything the rest of the
        // exchange encrypts and signs is derived from it — a state that printed
        // itself would hand over the whole pairing.
        srpSessionKey: Redacted.make(proof.sessionKey),
        verifyAccessoryProof: proof.verifyServer
      }
    }
  })
