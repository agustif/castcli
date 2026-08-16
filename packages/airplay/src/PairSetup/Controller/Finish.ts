/**
 * M6 — the accessory introduces itself, and the exchange either ends or is a
 * waste of the last five messages.
 *
 * M6 is the mirror of M5: a sealed sub-TLV holding the accessory's pairing
 * identifier, its Ed25519 long-term public key and a signature over
 * `X || identifier || public key`, where `X` is derived from the SRP shared
 * secret with the *accessory's* salt and info. Two things have to happen to it,
 * and both are easy to leave out.
 *
 * The sub-TLV has to be opened rather than parsed. Its tag is what says the
 * accessory holds the shared secret, and by extension that the pairing being
 * stored is with the device that displayed the setup code.
 *
 * The signature has to be verified. The tag proves the message came from
 * something holding the shared secret; the signature proves that the long-term
 * key inside it belongs to that same something. Without the second check, a
 * device that relayed the SRP exchange could put its own long-term key in the
 * sub-TLV, and every pair-verify from then on would authenticate the relay
 * instead of the television — successfully, forever, with nothing to notice.
 *
 * @since 0.1.0
 */
import { Effect, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Info, Nonce as NonceName, Salt, TlvType } from "../../Generated/index.ts"
import { type ForgedFrame, Nonce, Suite } from "../../Suite/index.ts"
import type {
  AccessoryRefused,
  MalformedItem,
  MissingItem,
  UnexpectedState,
  WrongSetupCode
} from "../Errors.ts"
import { SignatureRejected } from "../Errors.ts"
import { deviceInfo } from "./DeviceInfo.ts"
import { MAX_IDENTIFIER_BYTES } from "./Identity.ts"
import type { Pairing } from "./Pairing.ts"
import { atMost, exactly, read, required } from "./Response/index.ts"
import type { Exchanged } from "./State.ts"
import { open } from "./Sub/index.ts"

/** The State byte of the message this reads. */
const ANSWERING = 6

/** `ED25519_PUBLIC_KEY_BYTES` and `ED25519_BYTES`. */
const PUBLIC_KEY_BYTES = 32
const SIGNATURE_BYTES = 64

/**
 * Read M6 and produce the pairing, or fail rather than store one.
 *
 * **Details**
 *
 * The identifier is allowed to be any length up to 36 bytes, which is what an
 * accessory can store of a controller's and is taken here as the symmetric
 * limit. The ADK writes its device identifier — `"AA:BB:CC:DD:EE:FF"` — so in
 * practice it is 17.
 *
 * The public key and the signature are checked to the byte before they are used.
 * That matters more for the signature than it looks: `Suite.ed25519Verify` fails
 * rather than answering `false` for a wrong-sized signature, precisely so that a
 * truncated message cannot be reported as a peer that failed to authenticate,
 * and checking here means the report names the item and the length instead.
 *
 * **Gotchas**
 *
 * Nothing here checks that the accessory's identifier is one this controller has
 * seen before, because there is nothing to compare it against — this is the
 * exchange that learns it. It is the caller's business to notice if a
 * television's identifier changes between pairings.
 *
 * A `ForgedFrame` from opening the sub-TLV is not a wrong setup code either,
 * even though the ADK answers a failed decryption on its side with
 * `kHAPPairingError_Authentication`. By M6 both ends have already proved
 * knowledge of the code; a tag that does not verify here means the message was
 * altered in flight or the two ends disagree about the nonce.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 *
 * declare const m6Response: Uint8Array
 * declare const state: Exchanged
 * const pairing = finish(m6Response, state)
 * // => Effect<Pairing, …, Suite>
 * ```
 *
 * @category messages
 * @since 0.1.0
 */
export const finish = (
  m6Response: Uint8Array,
  state: Exchanged
): Effect.Effect<
  Pairing,
  | AccessoryRefused
  | ForgedFrame
  | MalformedItem
  | MissingItem
  | PlatformError
  | Schema.SchemaError
  | SignatureRejected
  | UnexpectedState
  | WrongSetupCode,
  Suite
> =>
  Effect.gen(function*() {
    const items = yield* read({ bytes: m6Response, step: "M6", state: ANSWERING })
    const sealed = yield* required({
      items,
      step: "M6",
      within: "message",
      type: TlvType.EncryptedData
    })
    const sub = yield* open({
      key: state.encryptionKey,
      nonce: yield* Nonce.label(NonceName.PSMsg06),
      sealed
    })

    const identifier = yield* atMost({
      items: sub,
      step: "M6",
      within: "sub-TLV",
      type: TlvType.Identifier,
      bytes: MAX_IDENTIFIER_BYTES
    })
    const publicKey = yield* exactly({
      items: sub,
      step: "M6",
      within: "sub-TLV",
      type: TlvType.PublicKey,
      bytes: PUBLIC_KEY_BYTES
    })
    const signature = yield* exactly({
      items: sub,
      step: "M6",
      within: "sub-TLV",
      type: TlvType.Signature,
      bytes: SIGNATURE_BYTES
    })

    const suite = yield* Suite
    const x = yield* suite.hkdfSha512({
      key: state.srpSessionKey,
      // The accessory's salt and info, not the controller's. The two
      // derivations differ in nothing else, and using ours here would produce a
      // verification that fails for a signature that is perfectly good.
      salt: Salt.PairSetupAccessorySign,
      info: Info.PairSetupAccessorySign
    })
    const verified = yield* suite.ed25519Verify({
      publicKey,
      message: deviceInfo({ x, identifier, publicKey }),
      signature
    })
    yield* verified ? Effect.void : Effect.fail(
      new SignatureRejected({ step: "M6", peer: "accessory" })
    )

    return {
      controller: { identifier: state.identifier, publicKey: state.publicKey },
      accessory: { identifier, publicKey }
    }
  })
