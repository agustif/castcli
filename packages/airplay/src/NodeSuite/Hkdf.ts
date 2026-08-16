/**
 * HKDF-SHA512, RFC 5869, on Node.
 *
 * @since 0.1.0
 */
import { Effect, PlatformError, Redacted } from "effect"
import * as NodeCrypto from "node:crypto"
import type { Suite } from "../Suite/Service.ts"
import { Sizes } from "../Suite/Sizes.ts"

/** The salt and info are specification constants in ASCII; UTF-8 encodes them. */
const utf8 = new TextEncoder()

/**
 * Extract-then-expand to one 32-byte key.
 *
 * **Details**
 *
 * `hkdfSync` is both steps in one call — HMAC-SHA512 over the input keying
 * material with the salt as key, then one round of expansion, which is all a
 * 32-byte output needs from a 64-byte hash. The synchronous form is used
 * deliberately: this is a pair of HMACs over a few hundred bytes, and the async
 * form buys a thread hop and a `Promise` the linter would rightly object to.
 *
 * **Gotchas**
 *
 * An empty salt is not an error — RFC 5869 substitutes a string of zeros the
 * length of the hash — so a bug that passes `""` where a salt belongs derives a
 * perfectly good key that the other end does not have.
 *
 * @category constructors
 * @since 0.1.0
 */
export const hkdfSha512: Suite["hkdfSha512"] = ({ info, key, salt }) =>
  Effect.try({
    try: () =>
      Redacted.make(
        new Uint8Array(
          NodeCrypto.hkdfSync(
            "sha512",
            Redacted.value(key),
            utf8.encode(salt),
            utf8.encode(info),
            Sizes.KEY
          )
        )
      ),
    catch: (cause) =>
      PlatformError.systemError({
        module: "Suite",
        method: "hkdfSha512",
        _tag: "Unknown",
        // Names the salt and info, which are public constants, and not the key.
        description: `could not derive a key with salt ${JSON.stringify(salt)} and info ${
          JSON.stringify(info)
        }`,
        cause
      })
  })
