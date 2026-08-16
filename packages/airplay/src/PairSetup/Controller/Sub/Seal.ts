/**
 * Sealing the sub-TLV that M5 carries.
 *
 * `kTLVType_EncryptedData` holds a whole TLV8 payload of its own, sealed with
 * ChaCha20-Poly1305 — a message inside a message, with its own item vocabulary
 * drawn from the same table. That nesting is the part of pair-setup most often
 * got wrong, usually by encrypting the three values concatenated rather than a
 * payload containing them, which produces something the same length that no
 * accessory can parse.
 *
 * @since 0.1.0
 */
import { Effect, type Redacted, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { type Item, Items } from "../../../Tlv8/index.ts"
import { type CiphertextWithTag, type Nonce, Suite } from "../../../Suite/index.ts"

/**
 * Items as an encrypted, authenticated payload with the tag appended.
 *
 * **Details**
 *
 * The plaintext is the sub-TLV encoded exactly as any pairing message is, so the
 * fragmentation rule applies inside it too — which matters for nothing pairing
 * sends today, since every value in a sub-TLV is under 255 bytes, and would
 * matter silently the first time one was not.
 *
 * The associated data is empty. HAP's `HAP_chacha20_poly1305_encrypt` is called
 * with no additional data for every pairing message; the control channel that
 * follows pairing is the thing that authenticates a length prefix that way.
 * Passing anything here instead would produce a frame that fails to
 * authenticate at the far end with the same error as a wrong key.
 *
 * **Gotchas**
 *
 * The nonce is a constant of the message — `PS-Msg05` for this one — and both
 * directions of the exchange share the derived key, so the nonce is the only
 * thing keeping the controller's sealed sub-TLV and the accessory's from
 * colliding. Sealing two different messages under the same key and nonce would
 * leak the exclusive-or of their plaintexts, which here means leaking a
 * long-term public key against a signature.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { GeneratedPairing } from "@castcli/airplay"
 * import { Nonce } from "../../../Suite/index.ts"
 *
 * const sealed = Effect.gen(function*() {
 *   return yield* seal({
 *     key: encryptionKey,
 *     nonce: yield* Nonce.label(GeneratedPairing.Nonce.PSMsg05),
 *     items: [
 *       { type: GeneratedPairing.TlvType.Identifier, value: identifier },
 *       { type: GeneratedPairing.TlvType.PublicKey, value: longTermPublicKey },
 *       { type: GeneratedPairing.TlvType.Signature, value: signature }
 *     ]
 *   })
 * })
 * ```
 *
 * @category encoding
 * @since 0.1.0
 */
export const seal = (options: {
  /** The 32 bytes HKDF derived with `Pair-Setup-Encrypt-Salt` and its info. */
  readonly key: Redacted.Redacted<Uint8Array>
  readonly nonce: Nonce.Nonce
  readonly items: ReadonlyArray<Item>
}): Effect.Effect<CiphertextWithTag, PlatformError | Schema.SchemaError, Suite> =>
  Effect.gen(function*() {
    const plaintext = yield* Schema.encodeEffect(Items)(options.items)
    const suite = yield* Suite
    return yield* suite.seal({
      key: options.key,
      nonce: options.nonce,
      plaintext,
      associatedData: new Uint8Array()
    })
  })
