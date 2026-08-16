/**
 * Opening the sub-TLV that M6 carries, and refusing to guess at a bad one.
 *
 * The inverse of `./Seal.ts`, and the place where the exchange's authentication
 * actually bites. ChaCha20-Poly1305 is a stream cipher with a tag: decrypting
 * with the wrong key produces plaintext-shaped bytes, and the only thing that
 * says they are not the accessory's are the sixteen bytes of tag. So a caller
 * that ignored the tag would go on to parse noise as a TLV8 payload, find an
 * item or two by chance, and eventually fail somewhere that has nothing to do
 * with the cause.
 *
 * `Suite.open` fails with `ForgedFrame` when the tag does not verify, and that
 * failure is passed straight on rather than being translated into something
 * about pairing. It is the most informative error in this exchange: it means the
 * two ends agreed about the setup code well enough to get here and then
 * disagreed about the key, the nonce, or the bytes in between.
 *
 * @since 0.1.0
 */
import { Effect, type Redacted, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { type Item, Items } from "../../../Tlv8/index.ts"
import {
  type CiphertextWithTag,
  type ForgedFrame,
  type Nonce,
  Suite
} from "../../../Suite/index.ts"

/**
 * A sealed sub-TLV as its items, or a failure that says which part went wrong.
 *
 * **Details**
 *
 * Three failures, and they are worth telling apart. `ForgedFrame` is the tag
 * refusing: the ciphertext is not what the holder of this key wrote. A
 * `SchemaError` is the tag *accepting* and the plaintext still not being a TLV8
 * payload, which cannot happen between two correct implementations and means one
 * of them is sealing something other than an encoded payload. A `PlatformError`
 * is the host's cryptography, and has nothing to do with the peer.
 *
 * **Gotchas**
 *
 * The tag is the last sixteen bytes, not the first — `Suite.CiphertextWithTag`
 * carries that layout, and HAP appends. A caller that hands over a frame with
 * the tag prepended gets `ForgedFrame` and no hint that the layout was the
 * problem.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { GeneratedPairing } from "@castcli/airplay"
 * import { Nonce } from "../../../Suite/index.ts"
 *
 * const items = Effect.gen(function*() {
 *   return yield* open({
 *     key: encryptionKey,
 *     nonce: yield* Nonce.label(GeneratedPairing.Nonce.PSMsg06),
 *     sealed: encryptedData
 *   })
 * })
 * ```
 *
 * @category decoding
 * @since 0.1.0
 */
export const open = (options: {
  /** The same key `./Seal.ts` used: both directions share it. */
  readonly key: Redacted.Redacted<Uint8Array>
  readonly nonce: Nonce.Nonce
  /** The `kTLVType_EncryptedData` value: ciphertext with the tag appended. */
  readonly sealed: CiphertextWithTag
}): Effect.Effect<
  ReadonlyArray<Item>,
  ForgedFrame | PlatformError | Schema.SchemaError,
  Suite
> =>
  Effect.gen(function*() {
    const suite = yield* Suite
    const plaintext = yield* suite.open({
      key: options.key,
      nonce: options.nonce,
      ciphertextAndTag: options.sealed,
      associatedData: new Uint8Array()
    })
    return yield* Schema.decodeUnknownEffect(Items)(plaintext)
  })
