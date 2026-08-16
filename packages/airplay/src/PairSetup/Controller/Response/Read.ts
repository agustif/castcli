/**
 * The three things done to every response, in the order they have to be done in.
 *
 * Decode the payload, notice a refusal, check the step. Each is somebody else's
 * file; what lives here is the order, because getting it wrong is what turns a
 * clear failure into a confusing one:
 *
 *   - decoding first, because a truncated payload cannot be reasoned about at
 *     all and `Tlv8.Items` is the only thing that rejoins fragments — the
 *     accessory's 384-byte public key arrives as two items, and a reader that
 *     skipped this would verify a proof against the first 255 bytes of it;
 *   - the refusal next, because a refusal is a well-formed message that contains
 *     none of the items the step is about to ask for, and asking first reports
 *     "M4 has no Proof item" for a device that said "wrong setup code";
 *   - the step last, because it is the check most likely to be *wrong* about a
 *     device rather than about a message, and it should not be what fires when
 *     the accessory has already told us plainly what happened.
 *
 * @since 0.1.0
 */
import { Effect, Schema } from "effect"
import { type Item, Items } from "../../../Tlv8/index.ts"
import type {
  AccessoryRefused,
  Step,
  UnexpectedState,
  WrongSetupCode
} from "../../Errors.ts"
import { expectState } from "./Expect.ts"
import { refusal } from "./Refusal.ts"

/**
 * A response's items, once it is known to be one of ours and not a refusal.
 *
 * **Details**
 *
 * Fails with `SchemaError` for a payload that is not well-formed TLV8, with
 * `AccessoryRefused` or `WrongSetupCode` for one carrying `kTLVType_Error`, and
 * with `UnexpectedState` for one belonging to a different step. A caller that
 * gets past it has items it can read without further ceremony.
 *
 * **When to use**
 *
 * At the top of `m3`, `m5` and `finish`, which is where all three of its callers
 * are. Nothing else in the exchange reads a response.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 *
 * declare const m2Response: Uint8Array
 * const items = read({ bytes: m2Response, step: "M2", state: 2 })
 * ```
 *
 * @category decoding
 * @since 0.1.0
 */
export const read = (options: {
  readonly bytes: Uint8Array
  readonly step: Step
  readonly state: number
}): Effect.Effect<
  ReadonlyArray<Item>,
  AccessoryRefused | Schema.SchemaError | UnexpectedState | WrongSetupCode
> =>
  Effect.gen(function*() {
    const items = yield* Schema.decodeUnknownEffect(Items)(options.bytes)
    yield* refusal({ items, step: options.step })
    yield* expectState({ items, step: options.step, state: options.state })
    return items
  })
