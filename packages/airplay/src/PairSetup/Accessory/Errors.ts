/**
 * The two ways a request is refused outright, as opposed to answered badly.
 *
 * Pair-setup has two quite different kinds of bad news and HAP keeps them apart,
 * so this does too.
 *
 * The first kind is a *protocol answer*: the setup code was wrong, the accessory
 * is already paired, too many attempts have been made. Those are not failures at
 * all here — they are a `kTLVType_Error` item in a perfectly well-formed
 * response, and `respond` returns those bytes successfully. See `Reject.ts`.
 *
 * The second kind is what this module names: the request could not be
 * *processed*. It was not a TLV8 payload, or it lacked an item the message is
 * defined to carry, or it announced a state this accessory is not in. The ADK
 * answers all of these by returning `kHAPError_InvalidData` or
 * `kHAPError_InvalidState` and resetting the session without writing a response,
 * because there is no message in the format that means "your message made no
 * sense". They belong in the error channel for the same reason: a caller must
 * not be able to mistake one for a response it can put on the wire.
 *
 * **These two errors are expected to move.** `PairSetup/Errors.ts` is where the
 * accessory and the controller are meant to share them, and it did not yet exist
 * when this was written. Nothing here is accessory-specific — a controller
 * rejects a malformed M2 for exactly these reasons — so at integration this file
 * should be deleted and the imports re-pointed one directory up.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * The request announced a state this accessory is not in.
 *
 * **Details**
 *
 * Every pair-setup message carries a `kTLVType_State` item naming which of the
 * six it is, and the ADK checks it twice: once against the state the session is
 * in, and once inside each handler against the constant that handler is for. A
 * mismatch is `kHAPError_InvalidData` and the procedure is abandoned.
 *
 * It is worth being clear about why an emulator must be equally strict, because
 * tolerance looks harmless here. The state byte is the only thing that says
 * which message this is; the items in M3 and M5 do not overlap, so a permissive
 * accessory that dispatched on "which items are present" would accept M5 sent
 * before M3 — and the keys M5 needs would be undefined rather than absent. More
 * to the point, this accessory exists to test a controller against, and a
 * controller that sends M3 twice is broken. An accessory that answers it anyway
 * lets the bug ship.
 *
 * `expected` is the state value that would have been answered here: 1, 3 or 5.
 * `received` is what arrived.
 *
 * @example
 * ```ts
 * new UnexpectedState({ expected: 3, received: 5 }).message
 * // => "pair-setup: expected the request for M3 (state 3), got state 5"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class UnexpectedState extends Schema.TaggedError<UnexpectedState>()(
  "PairSetupUnexpectedState",
  {
    expected: Schema.Number,
    received: Schema.Number
  }
) {
  override get message(): string {
    return `pair-setup: expected the request for M${this.expected} (state ${this.expected}), got state ${this.received}`
  }
}

/**
 * The request was not the message it claims to be.
 *
 * **Details**
 *
 * A missing item, an item of the wrong length, a payload that ends mid-item, or
 * a sub-TLV that decrypted and then turned out not to be TLV8. All of them mean
 * the sender and this implementation disagree about the format rather than about
 * a secret, which is why none of them is answered with
 * `kTLVType_Error = Authentication`: reporting a framing bug as a wrong PIN is
 * how a controller's developer spends a day retyping a setup code.
 *
 * `item` names the item at fault — `"kTLVType_Proof"` — or the payload itself,
 * and `reason` says what was wrong with it. Both are strings because they are
 * for a human reading a log; nothing branches on them.
 *
 * **Gotchas**
 *
 * `reason` must not quote the value. A malformed proof is attacker-supplied and
 * ends up in a log; its length is diagnostic, its contents are not.
 *
 * @example
 * ```ts
 * new MalformedMessage({ item: "kTLVType_Proof", reason: "expected 64 bytes, got 32" }).message
 * // => "pair-setup: kTLVType_Proof — expected 64 bytes, got 32"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class MalformedMessage extends Schema.TaggedError<MalformedMessage>()(
  "PairSetupMalformedMessage",
  {
    item: Schema.String,
    reason: Schema.String
  }
) {
  override get message(): string {
    return `pair-setup: ${this.item} — ${this.reason}`
  }
}
