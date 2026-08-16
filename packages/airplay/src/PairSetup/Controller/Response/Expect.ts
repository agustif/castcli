/**
 * `kTLVType_State`: which of the six messages this is.
 *
 * The six messages of pair-setup share one transport, one item vocabulary and,
 * in two cases, one outward shape — M4 and M6 are both a State and possibly an
 * `kTLVType_EncryptedData`, and M2 and M4 both carry values a reader could
 * mistake for the other's. The State byte is the only thing that tells them
 * apart, which makes checking it the cheapest protection there is against
 * reading a replayed or reordered message as the one that was expected.
 *
 * The ADK checks it on every message it receives and treats a mismatch as
 * `kHAPError_InvalidData`, which aborts the procedure. This is the mirror of
 * that.
 *
 * @since 0.1.0
 */
import { Effect, Option } from "effect"
import { TlvType } from "../../../Generated/index.ts"
import { byte, type Item } from "../../../Tlv8/index.ts"
import { type Step, UnexpectedState } from "../../Errors.ts"

/**
 * Fail unless the message says it is the step it was expected to be.
 *
 * **Details**
 *
 * Read through `Query.byte`, which answers `None` both for an absent State item
 * and for one that is not exactly one byte — HAP writes a single byte and
 * rejects any other length, so the two cases have the same answer and the error
 * says which by carrying an absent `received`.
 *
 * **Gotchas**
 *
 * Call this *after* `./Refusal.ts`. An error response carries a State item too,
 * and while the ADK happens to number it the same as the response it replaces,
 * an accessory that numbered it differently would then be reported as being at
 * the wrong step rather than as having refused — which is the one piece of
 * information the message actually contained.
 *
 * @example
 * ```ts
 * declare const items: ReadonlyArray<Item>
 * const checked = expectState({ items, step: "M2", state: 2 })
 * ```
 *
 * @category decoding
 * @since 0.1.0
 */
export const expectState = (options: {
  readonly items: ReadonlyArray<Item>
  readonly step: Step
  /** The State byte this step expects: 2 for M2, 4 for M4, 6 for M6. */
  readonly state: number
}): Effect.Effect<void, UnexpectedState> =>
  Option.match(byte(options.items, TlvType.State), {
    onNone: () =>
      Effect.fail(
        new UnexpectedState({
          step: options.step,
          expected: options.state,
          received: Option.none()
        })
      ),
    onSome: (state) =>
      state === options.state
        ? Effect.void
        : Effect.fail(
          new UnexpectedState({
            step: options.step,
            expected: options.state,
            received: Option.some(state)
          })
        )
  })
