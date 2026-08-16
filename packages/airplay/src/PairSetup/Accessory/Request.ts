/**
 * The two things every pair-setup request is, before anyone asks what it means:
 * a TLV8 payload, and a state byte saying which of the six messages it is.
 *
 * Both checks happen once, here, rather than at the top of each of M2, M4 and
 * M6. That is not only to avoid repeating them — it is because the ADK's
 * dispatcher reads the state byte *before* choosing a handler and each handler
 * then asserts it again, and collapsing the two into one place is the only way
 * to be sure the value the machine dispatched on is the value the handler
 * validated. Two separate reads of the same item is how a message gets handled
 * as M3 while announcing itself as M5.
 *
 * @since 0.1.0
 */
import { Effect, Option, Schema } from "effect"
import { TlvType } from "../../Generated/index.ts"
import * as Tlv8 from "../../Tlv8/index.ts"
import { MalformedMessage } from "./Errors.ts"

/**
 * A decoded request: its items, and the state it announces.
 *
 * @category models
 * @since 0.1.0
 */
export interface Request {
  /** The payload's items, fragments already rejoined. */
  readonly items: ReadonlyArray<Tlv8.Item>
  /** The value of `kTLVType_State`: which message of the exchange this is. */
  readonly state: number
}

const decodeItems = Schema.decodeUnknownEffect(Tlv8.Items)

/**
 * Read a request payload.
 *
 * **Details**
 *
 * Fails with `MalformedMessage` for a payload that is not TLV8 — which in this
 * format means one that ends mid-item, the only structural error the encoding
 * admits of — and for one carrying no usable `kTLVType_State`.
 *
 * "No usable state" folds together three of the ADK's separate complaints: the
 * item is absent, it is empty, or it is longer than one byte. They are one case
 * here because `Tlv8.byte` refuses to guess, and it is right to: taking the
 * first byte of a longer value would turn a controller that wrote its state as a
 * 32-bit integer into a request that dispatches correctly on a little-endian
 * machine and to state zero on a big-endian one.
 *
 * **Gotchas**
 *
 * Nothing here says the state is one this accessory expects, or that the items
 * the message needs are present. Those are the caller's questions, because the
 * answers differ per message and the second one depends on the first.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { decode } from "./Request.ts"
 *
 * const request = decode(Uint8Array.from([6, 1, 1, 0, 1, 0]))
 * // => { items: [...], state: 1 }
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const decode = (
  payload: Uint8Array
): Effect.Effect<Request, MalformedMessage> =>
  Effect.gen(function*() {
    const items = yield* Effect.mapError(
      decodeItems(payload),
      // The schema issue is not carried through. It describes a byte offset in
      // a payload the caller still has, and this error is destined for a log
      // that must not grow attacker-supplied text.
      () => new MalformedMessage({ item: "the payload", reason: "not a TLV8 payload" })
    )
    const state = yield* Option.match(Tlv8.byte(items, TlvType.State), {
      onNone: () =>
        Effect.fail(
          new MalformedMessage({
            item: "kTLVType_State",
            reason: "missing, or not exactly one byte"
          })
        ),
      onSome: Effect.succeed
    })
    return { items, state }
  })
