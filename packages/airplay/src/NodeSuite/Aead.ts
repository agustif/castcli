/**
 * ChaCha20-Poly1305, RFC 8439, on Node.
 *
 * Seal and open live in one file because they are one primitive seen from two
 * sides: every decision below — the tag goes last, the associated data is
 * offered before the body, sixteen bytes of tag — has to be made identically in
 * both or neither works, and a reader checking that is served by having them
 * adjacent.
 *
 * @since 0.1.0
 */
import { Effect, PlatformError, Redacted } from "effect"
import * as NodeCrypto from "node:crypto"
import { ForgedFrame } from "../Suite/Errors.ts"
import type { Suite } from "../Suite/Service.ts"
import { Sizes } from "../Suite/Sizes.ts"

const ALGORITHM = "chacha20-poly1305"

/**
 * Encrypt and authenticate, returning ciphertext with the tag appended.
 *
 * **Details**
 *
 * The tag is appended rather than returned separately because that is HAP's
 * layout — see `CiphertextWithTag` — so a sealed frame is exactly 16 bytes
 * longer than its plaintext and needs no framing of its own.
 *
 * **Gotchas**
 *
 * `authTagLength` is passed explicitly even though 16 is the default for this
 * cipher. OpenSSL will happily produce a shorter Poly1305 tag if asked, and a
 * truncated tag is a weaker authenticator that still verifies against itself —
 * exactly the kind of failure that shows up only when a real device rejects it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const seal: Suite["seal"] = ({ associatedData, key, nonce, plaintext }) =>
  Effect.try({
    try: () => {
      const cipher = NodeCrypto.createCipheriv(
        ALGORITHM,
        Redacted.value(key),
        nonce.bytes,
        { authTagLength: Sizes.TAG }
      )
      cipher.setAAD(associatedData)
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return Uint8Array.from(Buffer.concat([body, cipher.getAuthTag()]))
    },
    catch: (cause) =>
      PlatformError.systemError({
        module: "Suite",
        method: "seal",
        _tag: "Unknown",
        description: "could not seal a frame",
        cause
      })
  })

/**
 * Verify and decrypt a frame sealed by {@link seal}.
 *
 * **Details**
 *
 * Two effects, not one, and the split is where the error types part company.
 * Building the decipher — the cipher name, the key, the nonce, the tag length —
 * can only fail because this process is wrong or the host is; once it has been
 * built with a 32-byte key, a 12-byte nonce and a 16-byte tag, the only thing
 * left that can fail is `final()`, and `final()` fails exactly when Poly1305
 * says the frame was not written by someone holding the key.
 *
 * That is why the second stage can attribute its failure to a forged frame
 * without inspecting the message Node threw. Matching on a string like
 * "Unsupported state or unable to authenticate data" would be the alternative,
 * and it is one Node has changed before.
 *
 * **Gotchas**
 *
 * Do not retry, and do not fall back to opening without the associated data. A
 * frame that fails to authenticate has told you nothing about itself; treating
 * it as an unauthenticated frame is how an attacker gets their plaintext
 * accepted.
 *
 * @category constructors
 * @since 0.1.0
 */
export const open: Suite["open"] = ({ associatedData, ciphertextAndTag, key, nonce }) =>
  Effect.flatMap(
    Effect.try({
      try: () => {
        const decipher = NodeCrypto.createDecipheriv(
          ALGORITHM,
          Redacted.value(key),
          nonce.bytes,
          { authTagLength: Sizes.TAG }
        )
        decipher.setAuthTag(ciphertextAndTag.subarray(ciphertextAndTag.length - Sizes.TAG))
        decipher.setAAD(associatedData)
        return decipher
      },
      catch: (cause) =>
        PlatformError.systemError({
          module: "Suite",
          method: "open",
          _tag: "Unknown",
          description: "could not prepare to open a frame",
          cause
        })
    }),
    (decipher) =>
      Effect.try({
        try: () =>
          Uint8Array.from(
            Buffer.concat([
              decipher.update(ciphertextAndTag.subarray(0, ciphertextAndTag.length - Sizes.TAG)),
              decipher.final()
            ])
          ),
        // The thrown value is discarded, which is the one place in this package
        // that happens. Node reports every authentication failure as the same
        // stateless "unable to authenticate data" with no code and no detail, so
        // there is nothing in it a caller could act on — and carrying it would
        // invite exactly the string-matching this split exists to avoid.
        catch: () =>
          new ForgedFrame({
            nonce: nonce.bytes,
            sealedBytes: ciphertextAndTag.length
          })
      })
  )
