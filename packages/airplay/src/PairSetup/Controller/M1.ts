/**
 * M1 — asking the accessory to start pair-setup.
 *
 * The smallest message in the exchange and the only one that depends on nothing:
 * a state, a method, and the flags if any were asked for. Nothing is carried
 * away from it, which is why it returns bytes rather than bytes and a state —
 * everything M3 needs comes from the setup code and from M2's answer.
 *
 * `kTLVType_Method` is always `PairSetup`. `PairSetupWithAuth` is the other
 * method the ADK accepts, and it is deliberately not offered here: it asks the
 * accessory to prove itself with an Apple Authentication Coprocessor
 * certificate, which arrives in M4's encrypted sub-TLV, and verifying that chain
 * is not something this package can do. A controller that requested it and then
 * ignored the certificate would be strictly worse off than one that never asked,
 * because it would have told the accessory that the certificate mattered.
 *
 * @since 0.1.0
 */
import { Effect, Schema } from "effect"
import type { PairingFlag } from "../../Generated/index.ts"
import { PairingMethod, TlvType } from "../../Generated/index.ts"
import { Items } from "../../Tlv8/index.ts"
import { Flags } from "./Flags.ts"

/** The State byte of the first message. */
const STATE = 1

/**
 * What the caller gets to decide about the exchange.
 *
 * **Details**
 *
 * `flags` is required rather than optional even though passing `[]` is the
 * ordinary case, for the reason `Suite.seal` requires its associated data: an
 * optional field is the one people forget, and forgetting this one asks for an
 * ordinary pairing when the caller meant a transient one — which succeeds, and
 * leaves the caller waiting for an M6 that is never coming.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The pairing flags to request, or `[]` for none.
   *
   * `Transient` asks for an exchange that stops after M4 and derives session
   * keys from the SRP secret without ever exchanging long-term keys — AirPlay
   * uses it for a receiver that does not want to be remembered. `Split` asks the
   * accessory to keep its setup info so that a later exchange can reuse it,
   * which is what makes the two-stage transient-then-full flow possible. The
   * ADK ignores both unless the method is `PairSetup`, which it always is here.
   *
   * There is no step in this module for what follows a transient exchange. It
   * ends at M4 — the accessory resets its pair-setup state there and derives
   * its session keys from the SRP secret with `SplitSetupSalt` — so a caller
   * that asks for `Transient` must stop after M4 and derive the control channel
   * keys itself, and must not call `m5`. That is a gap, not a decision: the
   * control channel is not part of this exchange.
   */
  readonly flags: ReadonlyArray<PairingFlag>
}

/**
 * The first request: `State 1`, `Method PairSetup`, and the flags if any.
 *
 * **Details**
 *
 * The flags item is omitted entirely when no flags were asked for. That is not
 * an optimisation — it is the encoding: `HAPPairingGetNumBytes(0)` is zero, so a
 * zero-valued field has no bytes, and writing an empty item instead would leave
 * the ADK reading `flagsPresent = true` with a value of zero, which is a
 * different thing from the caller's point of view than not having asked.
 *
 * **Gotchas**
 *
 * The item order here is State, Method, Flags, and it is not significant: the
 * ADK's reader takes the set of types it expects and matches whatever arrives in
 * whatever order. Tests that assert on the exact bytes are asserting on this
 * function's choice, not on a requirement of the protocol.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * const request = m1({ flags: [] })
 * // => Uint8Array [6, 1, 1, 0, 1, 0]
 *
 * const transient = m1({ flags: [GeneratedPairing.PairingFlag.Transient] })
 * // => Uint8Array [6, 1, 1, 0, 1, 0, 19, 1, 16]
 * ```
 *
 * @category messages
 * @since 0.1.0
 */
export const m1 = (
  options: Options
): Effect.Effect<Uint8Array, Schema.SchemaError> =>
  Effect.gen(function*() {
    const flags = yield* Schema.encodeEffect(Flags)(
      options.flags.reduce((all, flag) => all | flag, 0)
    )
    return yield* Schema.encodeEffect(Items)([
      { type: TlvType.State, value: Uint8Array.of(STATE) },
      { type: TlvType.Method, value: Uint8Array.of(PairingMethod.PairSetup) },
      // Zero flags encode to zero bytes, so this is the "omit the item" rule
      // stated once, in the codec, rather than as a second condition here that
      // could disagree with it.
      ...(flags.length === 0 ? [] : [{ type: TlvType.Flags, value: flags }])
    ])
  })
