/**
 * The nonce a control-channel frame is sealed under: four zero bytes, then a
 * 64-bit little-endian counter.
 *
 * Once pairing is done the session settles into a stream of encrypted frames in
 * each direction, each one sealed under the same key with the counter advanced
 * by one. Endianness is the whole of the risk here: eight bytes read the wrong
 * way round give a nonce that is well-formed, unique, and agrees with no
 * receiver ever built, and the symptom is an authentication failure on the very
 * first frame after pairing succeeded — which reads as a pairing bug.
 *
 * The counter is `bigint` rather than `number` because it is a 64-bit field and
 * a double stops counting exactly at 2^53. A long-lived session will not reach
 * that, but a counter that silently stops incrementing is a nonce reuse, and
 * nonce reuse under a stream cipher is a total loss of confidentiality for the
 * two frames involved. There is no reason to make that depend on how long
 * someone watches a film for.
 *
 * @since 0.1.0
 */
import { Effect, PlatformError } from "effect"
import { Sizes } from "../Sizes.ts"
import * as Nonce from "./Nonce.ts"

/** One past the largest 64-bit counter. */
const LIMIT = 1n << 64n

/** The count as eight little-endian bytes. */
const suffixOf = (count: bigint): Uint8Array => {
  const suffix = new Uint8Array(Sizes.NONCE_SUFFIX)
  new DataView(suffix.buffer).setBigUint64(0, count, true)
  return suffix
}

/**
 * The nonce for the nth frame of a control channel.
 *
 * **Details**
 *
 * Each direction of a session counts separately and each starts at zero, so the
 * caller holds two counters, not one. This function is deliberately given the
 * count rather than holding it: a nonce source that incremented internally would
 * be a piece of mutable state shared between the send and receive paths, and the
 * failure mode of getting that wrong is nonce reuse.
 *
 * **Gotchas**
 *
 * Never seal two frames of the same direction under the same count. Poly1305's
 * one-time key is derived from the nonce, so a repeat leaks the authentication
 * key as well as the exclusive-or of the plaintexts.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import * as Counter from "./Counter.ts"
 *
 * const first = Effect.gen(function*() {
 *   return yield* Counter.counter(0n)
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const counter = (
  count: bigint
): Effect.Effect<Nonce.Nonce, PlatformError.PlatformError> =>
  count >= 0n && count < LIMIT
    ? Effect.succeed(Nonce.fromSuffix(suffixOf(count)))
    : Effect.fail(
      PlatformError.badArgument({
        module: "Suite",
        method: "Nonce.counter",
        description: `a frame counter is a 64-bit unsigned integer; got ${count}`
      })
    )
