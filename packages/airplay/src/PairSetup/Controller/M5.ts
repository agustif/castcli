/**
 * M5 — checking the accessory's proof, then handing over a long-term identity.
 *
 * Two unrelated things happen here, and they happen in this order for a reason.
 * M4 carries the accessory's SRP proof, and checking it is the moment the
 * exchange becomes mutual: until then the controller has proved it knows the
 * setup code and the accessory has proved nothing at all. Only after that does
 * this send anything of its own, and what it sends is the identity the accessory
 * will trust from then on. A controller that skipped the check would introduce
 * its long-term key to whatever answered.
 *
 * The payload is where implementations go wrong. It is not three items in the
 * message; it is a *sub-TLV* — a whole TLV8 payload of identifier, public key
 * and signature — sealed with ChaCha20-Poly1305 under a key derived from the SRP
 * shared secret, and carried as the value of one `kTLVType_EncryptedData` item.
 * `HAPPairingPairSetupProcessM5` is the reader that takes it apart, and it is
 * the authority on every detail here.
 *
 * @since 0.1.0
 */
import { Effect, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
// `Nonce` is a name this file needs twice: the generated table of nonce strings,
// and the suite's opaque twelve-byte value. The table is the one renamed,
// because the value is the one that appears in signatures.
import { Info, Nonce as NonceName, Salt, TlvType } from "../../Generated/index.ts"
import { Items } from "../../Tlv8/index.ts"
import { Nonce, Suite } from "../../Suite/index.ts"
import type { Errors as SrpErrors } from "../../Srp/index.ts"
import type {
  AccessoryRefused,
  MalformedItem,
  MissingItem,
  UnexpectedState,
  WrongSetupCode
} from "../Errors.ts"
import { IdentifierTooLong } from "../Errors.ts"
import { deviceInfo } from "./DeviceInfo.ts"
import { type Identity, MAX_IDENTIFIER_BYTES } from "./Identity.ts"
import { exactly, read } from "./Response/index.ts"
import type { Exchanged, Proved } from "./State.ts"
import { seal } from "./Sub/index.ts"

/** The State byte this message answers, and the one it sends. */
const ANSWERING = 4
const STATE = 5

/** `SRP_PROOF_BYTES` — SHA-512, so 64. */
const PROOF_BYTES = 64

/**
 * Read M4 and produce M5, with the state `finish` will need.
 *
 * **Details**
 *
 * Three derivations from the same SRP session key, and they must not be confused
 * with one another:
 *
 *   - the encryption key, from `Pair-Setup-Encrypt-Salt` and its info, seals
 *     this message's sub-TLV and opens M6's;
 *   - `X`, from `Pair-Setup-Controller-Sign-Salt` and its info, is the first 32
 *     bytes of what this controller signs;
 *   - M6's `X`, from the *accessory* salt and info, is what it signs, and is
 *     derived in `./Finish.ts` rather than here.
 *
 * All three are HKDF-SHA512 over the same input with a different salt and info,
 * so all three are 32 indistinguishable bytes and swapping two of them produces
 * a message that is well-formed, encrypts cleanly, and is rejected at the far
 * end with `kHAPPairingError_Authentication` — the same answer as a wrong setup
 * code.
 *
 * **Gotchas**
 *
 * A failure from `verifyAccessoryProof` is not a wrong setup code, however much
 * it looks like one. The accessory already accepted the controller's proof, or
 * it would have answered M4 with an error instead of a proof of its own; a proof
 * that does not verify means the peer could not demonstrate it holds the
 * verifier. Retrying with the same code cannot help, and retrying at all against
 * a peer that has just failed to authenticate is how a detected impersonation
 * becomes a loop.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 *
 * declare const m4Response: Uint8Array
 * declare const state: Proved
 * declare const identity: Identity
 * const next = Effect.gen(function*() {
 *   const { request, state: exchanged } = yield* m5(m4Response, { state, identity })
 *   return exchanged
 * })
 * ```
 *
 * @category messages
 * @since 0.1.0
 */
export const m5 = (
  m4Response: Uint8Array,
  options: {
    readonly state: Proved
    readonly identity: Identity
  }
): Effect.Effect<
  { readonly request: Uint8Array; readonly state: Exchanged },
  | AccessoryRefused
  | IdentifierTooLong
  | MalformedItem
  | MissingItem
  | PlatformError
  | Schema.SchemaError
  | SrpErrors.ProofRejected
  | UnexpectedState
  | WrongSetupCode,
  Suite
> =>
  Effect.gen(function*() {
    const items = yield* read({ bytes: m4Response, step: "M4", state: ANSWERING })
    const accessoryProof = yield* exactly({
      items,
      step: "M4",
      within: "message",
      type: TlvType.Proof,
      bytes: PROOF_BYTES
    })
    // Before anything of ours goes out. Everything below introduces a long-term
    // key to the peer, and this is the only thing that has established there is
    // anything there worth introducing it to.
    yield* options.state.verifyAccessoryProof(accessoryProof)

    const identifier = new TextEncoder().encode(options.identity.identifier)
    // Checked here rather than left to the accessory, which answers an
    // over-long identifier by aborting the procedure with no error TLV at all —
    // a controller would see the exchange simply stop.
    yield* identifier.length <= MAX_IDENTIFIER_BYTES ? Effect.void : Effect.fail(
      new IdentifierTooLong({
        bytes: identifier.length,
        limit: MAX_IDENTIFIER_BYTES
      })
    )

    const suite = yield* Suite
    const encryptionKey = yield* suite.hkdfSha512({
      key: options.state.srpSessionKey,
      salt: Salt.PairSetupEncrypt,
      info: Info.PairSetupEncrypt
    })
    const x = yield* suite.hkdfSha512({
      key: options.state.srpSessionKey,
      salt: Salt.PairSetupControllerSign,
      info: Info.PairSetupControllerSign
    })
    const publicKey = options.identity.keys.publicKey
    const signature = yield* suite.ed25519Sign({
      privateKey: options.identity.keys.privateKey,
      message: deviceInfo({ x, identifier, publicKey })
    })

    const sealed = yield* seal({
      key: encryptionKey,
      nonce: yield* Nonce.label(NonceName.PSMsg05),
      items: [
        { type: TlvType.Identifier, value: identifier },
        { type: TlvType.PublicKey, value: publicKey },
        { type: TlvType.Signature, value: signature }
      ]
    })

    const request = yield* Schema.encodeEffect(Items)([
      { type: TlvType.State, value: Uint8Array.of(STATE) },
      { type: TlvType.EncryptedData, value: sealed }
    ])

    return {
      request,
      state: {
        // Carried on rather than consumed: M6's signature is over a value
        // derived from K with the accessory's salt and info, which cannot be
        // derived until M6 says whose signature it is.
        srpSessionKey: options.state.srpSessionKey,
        encryptionKey,
        identifier,
        publicKey
      }
    }
  })
