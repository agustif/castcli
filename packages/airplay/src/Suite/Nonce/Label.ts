/**
 * The nonce a pairing message is sealed under: four zero bytes, then a label.
 *
 * HAP names each encrypted message of pair-setup and pair-verify with an
 * eight-character string — `PS-Msg04`, `PS-Msg05`, `PS-Msg06`, `PV-Msg02`,
 * `PV-Msg03` — and uses that string, in ASCII, as the tail of the nonce. Since
 * every message in an exchange is sealed under the same derived key, the label
 * is the only thing keeping two of them from sharing a nonce, which for a stream
 * cipher would leak the exclusive-or of the two plaintexts.
 *
 * @since 0.1.0
 */
import { Effect, PlatformError } from "effect"
import { Sizes } from "../Sizes.ts"
import * as Nonce from "./Nonce.ts"

/**
 * Exactly eight printable ASCII characters.
 *
 * Both halves matter. Eight, because a shorter label would be zero-padded by
 * {@link Nonce.fromSuffix} into a nonce that is perfectly valid and agrees with
 * nothing on the other end. ASCII, because a label is encoded as UTF-8 and any
 * character above U+007F occupies more than one byte — so a label of eight
 * *characters* would be nine or more *bytes*, and the check that matters is on
 * bytes.
 */
const LABEL = /^[\x20-\x7e]{8}$/

/**
 * The nonce for a named HAP pairing message.
 *
 * **Details**
 *
 * Fails rather than truncating or padding. A label of the wrong length is a
 * typo in a constant, and the only symptom it would otherwise produce is a
 * `ForgedFrame` from the far end of a pairing exchange, several messages later,
 * with nothing pointing back at the string.
 *
 * **When to use**
 *
 * For every message of pair-setup and pair-verify. The control channel that
 * follows pairing uses {@link counter} instead.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import * as Label from "./Label.ts"
 *
 * const nonce = Effect.gen(function*() {
 *   return yield* Label.label("PS-Msg05")
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const label = (
  text: string
): Effect.Effect<Nonce.Nonce, PlatformError.PlatformError> =>
  LABEL.test(text)
    ? Effect.succeed(Nonce.fromSuffix(new TextEncoder().encode(text)))
    : Effect.fail(
      PlatformError.badArgument({
        module: "Suite",
        method: "Nonce.label",
        description:
          `a nonce label is ${Sizes.NONCE_SUFFIX} printable ASCII characters, such as "PS-Msg05"; got ${
            JSON.stringify(text)
          }`
      })
    )
