/**
 * The one item that has to be looked for before anything else.
 *
 * An accessory that will not go on answers with `kTLVType_State` and
 * `kTLVType_Error` and nothing else — see `HAPPairingPairSetupGetErrorResponse`
 * — so a reader that reaches for the salt, or the proof, or the encrypted data
 * first finds it absent and reports a missing item. The message is not missing
 * anything; it is a refusal, and it says exactly why. Checking this first is the
 * difference between "the accessory said your setup code was wrong" and "the
 * accessory's M4 had no Proof item".
 *
 * @since 0.1.0
 */
import { Effect, Option } from "effect"
import { TlvType } from "../../../Generated/index.ts"
import { find, type Item } from "../../../Tlv8/index.ts"
import {
  type AccessoryRefused,
  fromWire,
  type Step,
  type WrongSetupCode
} from "../../Errors.ts"

/**
 * Fail if the accessory declined; otherwise do nothing.
 *
 * **Details**
 *
 * Any `kTLVType_Error` item at all is a refusal, whatever its length. That is
 * deliberately laxer than the rest of this module, which insists on exact
 * widths: HAP writes the error as a single byte and nothing else is expected,
 * but an item that is present and the wrong size is still a peer saying no, and
 * treating it as absent would carry on talking to something that has stopped.
 *
 * This is also why the value is read directly rather than through `Query.byte`,
 * which answers `None` for an item that is not exactly one byte — the right
 * answer everywhere else, and the wrong one here for precisely that reason.
 *
 * **When to use**
 *
 * On every response, before any other item is read. `./Read.ts` does it for the
 * three the controller receives.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 *
 * // 06 01 04  07 01 02 — State 4, Error 2.
 * declare const items: ReadonlyArray<Item>
 * const checked = refusal({ items, step: "M4" })
 * // fails with WrongSetupCode
 * ```
 *
 * @category decoding
 * @since 0.1.0
 */
export const refusal = (options: {
  readonly items: ReadonlyArray<Item>
  readonly step: Step
}): Effect.Effect<void, AccessoryRefused | WrongSetupCode> =>
  Option.match(find(options.items, TlvType.Error), {
    onNone: () => Effect.void,
    onSome: (value) =>
      Effect.fail(
        // An empty error item leaves nothing to name the reason, and `0` is not
        // a code HAP defines, so it is reported as an unnamed refusal rather
        // than guessed at. That is honest and rare: the ADK always writes one
        // byte.
        fromWire({ step: options.step, code: value[0] ?? 0 })
      )
  })
