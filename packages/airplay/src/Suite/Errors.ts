/**
 * The one failure of this service that is not a platform failure.
 *
 * Everything else `Suite` can do wrong is reported as a `PlatformError`, exactly
 * as `Crypto` reports a failed digest: the host's cryptography refused, or the
 * caller handed it something of the wrong length, and in both cases something is
 * broken and the program should say so.
 *
 * An AEAD that fails to authenticate is not that. It is the primitive doing its
 * job. The frame was altered in flight, or it was written by someone who does
 * not hold the session key, or — much the most common case during development —
 * the two ends disagree about the nonce or the associated data. A caller that
 * receives it has a decision to make: a control channel drops the connection, a
 * pairing exchange answers with an authentication error and lets the user try
 * again. Folding it into `PlatformError` would put that decision behind a string
 * comparison on a description, which is how "the tag did not verify" ends up
 * being logged as "the platform is broken".
 *
 * @since 0.1.0
 */
import { Data, Encoding } from "effect"

/**
 * A sealed frame that did not authenticate.
 *
 * **Details**
 *
 * Carries the nonce it was opened under and the length of the frame, and
 * nothing else. Both are public — a nonce is sent in the clear or derived from a
 * counter both ends already know — so this error is safe to log in full, which
 * matters because the thing a reader needs in order to debug an AEAD mismatch is
 * precisely which nonce was used.
 *
 * The key, the plaintext and the tag are deliberately absent. A failed open
 * tells an attacker nothing today; an error that quoted the key would change
 * that.
 *
 * **When to use**
 *
 * Match on it to distinguish a forged or corrupted frame from a broken host.
 * Never retry an open on receiving it — with the same key and nonce it will fail
 * identically, and with a *different* nonce it would silently accept a replayed
 * frame.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { ForgedFrame } from "./Errors.ts"
 *
 * const drop = (error: ForgedFrame) => Effect.logWarning(error.message)
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class ForgedFrame extends Data.TaggedError("ForgedFrame")<{
  /** The twelve nonce bytes the frame was opened under. */
  readonly nonce: Uint8Array
  /** The length of the sealed frame, tag included. */
  readonly sealedBytes: number
}> {
  /**
   * A message naming the nonce, because that is the field the two ends usually
   * disagree about.
   *
   * @since 0.1.0
   */
  override get message(): string {
    return `a ${this.sealedBytes}-byte frame failed to authenticate under nonce ${
      Encoding.encodeHex(this.nonce)
    } — it was altered, or the sender used a different key, nonce or associated data`
  }
}
