/**
 * The ways a pair-setup exchange ends badly, on either side of it.
 *
 * Six messages, three of them read by the controller and three by the
 * accessory, and every one of them can fail in the same four shapes: the peer
 * declined, the peer answered about a different step, an item this step needs is
 * not there, or an item is there and is the wrong size. Rather than each of the
 * six inventing its own vocabulary, the shapes live here and carry which step
 * they happened at — so a caller handling "the accessory refused" writes one
 * branch rather than three, and a log line names the message without the reader
 * having to work out which function produced it.
 *
 * Two of these are worth more than the others.
 *
 * {@link WrongSetupCode} is separate from {@link AccessoryRefused} because it is
 * the only failure the *user* can fix, and the only correct response to it is to
 * say "that code was wrong" and ask again. HAP reports it as one byte among
 * seven — `kHAPPairingError_Authentication` — and an implementation that folds
 * all seven into one error makes "the accessory is busy" and "you mistyped the
 * code" indistinguishable at the call site, which is how a pairing dialog ends
 * up telling a user to check their PIN when the television is simply already
 * paired with somebody else.
 *
 * {@link SignatureRejected} is the failure that means someone is lying. Every
 * other error here is a peer that is unhappy or a message that is malformed;
 * this one is a peer that produced a signature over key material it does not
 * hold. It must never be retried.
 *
 * @since 0.1.0
 */
import { Data, Option, Schema } from "effect"
import { PairingError, PairingErrorFromWire, TlvType } from "../Generated/index.ts"

/**
 * Which of the six messages a failure happened at.
 *
 * **Details**
 *
 * Named by the message being *processed*, not by the side processing it: a
 * controller reads M2, M4 and M6 and writes M1, M3 and M5, and the accessory is
 * the mirror of that. So `step: "M4"` on an error a controller raised means the
 * accessory's fourth message was the problem, and `step: "M5"` on one the
 * accessory raised means the controller's fifth was.
 *
 * @category models
 * @since 0.1.0
 */
export type Step = "M1" | "M2" | "M3" | "M4" | "M5" | "M6"

/**
 * Whether an item was missing from the message itself or from the encrypted
 * sub-TLV inside it.
 *
 * **Details**
 *
 * The distinction is the whole difference between a peer that sent a malformed
 * message and one that sent a well-formed message whose *contents* are wrong.
 * They are debugged from opposite ends: a missing item in the message is visible
 * in a packet capture, and a missing item in the sub-TLV is only visible to
 * someone holding the session key.
 *
 * @category models
 * @since 0.1.0
 */
export type Scope = "message" | "sub-TLV"

/**
 * The name a generated vocabulary gives a value, for a human-readable message.
 *
 * Looked up rather than restated: the numbers come from Apple's header through
 * `GeneratedPairing`, and a second table of names here would be one more thing
 * to keep in step with it. A value the vocabulary does not define — which is
 * exactly what an accessory from a newer specification would send — has no name,
 * and saying so is more useful than guessing at one.
 */
const nameOf = (
  vocabulary: Readonly<Record<string, number>>,
  value: number
): string =>
  Object.entries(vocabulary).find(([, defined]) => defined === value)?.[0] ??
    "an unnamed value"

/**
 * The accessory declined, for a reason that is not the setup code.
 *
 * **Details**
 *
 * Carries the byte exactly as it arrived, whether or not HAP defines it, because
 * an accessory that declines with a code from a specification newer than this
 * one has still declined and a caller still has to stop. {@link message} names
 * the code when the vocabulary has a name for it.
 *
 * **When to use**
 *
 * Match on it to abandon the exchange. None of the codes it carries are
 * retryable on the spot: `Backoff` and `MaxTries` want a delay, `Busy` and
 * `Unavailable` want a different moment, and `MaxPeers` wants a pairing removed
 * on the television first.
 *
 * **Gotchas**
 *
 * A wrong setup code arrives as {@link WrongSetupCode} instead, never as this —
 * see {@link fromWire}, which is the only thing that should construct either.
 *
 * @example
 * ```ts
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * new AccessoryRefused({ step: "M2", code: GeneratedPairing.PairingError.Busy }).message
 * // => "pair-setup M2: the accessory declined with Busy (7)"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class AccessoryRefused extends Data.TaggedError("PairSetupAccessoryRefused")<{
  readonly step: Step
  /** The `kTLVType_Error` byte, as it arrived. */
  readonly code: number
}> {
  /**
   * @since 0.1.0
   */
  override get message(): string {
    return `pair-setup ${this.step}: the accessory declined with ${
      nameOf(PairingError, this.code)
    } (${this.code})`
  }
}

/**
 * The setup code the user typed is not the one on the screen.
 *
 * **Details**
 *
 * `kHAPPairingError_Authentication`, and the only failure in this module that a
 * user can do anything about. It arrives at M4 in the ordinary case — the
 * accessory checks the controller's SRP proof there and answers with this when
 * it does not verify — and can also arrive at M6, where it means the sub-TLV of
 * M5 did not decrypt or its signature did not check out. Those are the same
 * cause seen twice: both derive from the shared secret, and the shared secret is
 * wrong precisely when the code was.
 *
 * **When to use**
 *
 * Tell the user their code was wrong and let them try again. It is the one error
 * here where retrying is the right thing to do — though not indefinitely: the
 * ADK stops answering at all after a hundred failures and starts returning
 * `MaxTries`, which arrives as {@link AccessoryRefused}.
 *
 * @example
 * ```ts
 * new WrongSetupCode({ step: "M4" }).message
 * // => "pair-setup M4: the accessory rejected the setup code"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class WrongSetupCode extends Data.TaggedError("PairSetupWrongSetupCode")<{
  readonly step: Step
}> {
  /**
   * @since 0.1.0
   */
  override get message(): string {
    return `pair-setup ${this.step}: the accessory rejected the setup code`
  }
}

/**
 * A `kTLVType_Error` byte, as the error it stands for.
 *
 * **Details**
 *
 * Decoded through `GeneratedPairing.PairingErrorFromWire` rather than compared
 * against a literal, so a byte outside HAP's vocabulary is noticed rather than
 * mistaken for one of the seven; it still becomes an {@link AccessoryRefused},
 * because a peer declining in a way we do not recognise has still declined and
 * pretending otherwise would continue the exchange against a device that has
 * stopped listening.
 *
 * **Gotchas**
 *
 * `code` must be a byte the accessory actually sent. HAP never sends zero — the
 * item is absent when there is no error — so passing zero here produces an
 * `AccessoryRefused` for an error that did not happen.
 *
 * @example
 * ```ts
 * fromWire({ step: "M4", code: 2 })._tag // => "PairSetupWrongSetupCode"
 * fromWire({ step: "M4", code: 7 })._tag // => "PairSetupAccessoryRefused"
 * fromWire({ step: "M4", code: 99 })._tag // => "PairSetupAccessoryRefused"
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromWire = (options: {
  readonly step: Step
  readonly code: number
}): AccessoryRefused | WrongSetupCode =>
  Option.match(Schema.decodeUnknownOption(PairingErrorFromWire)(options.code), {
    onNone: () => new AccessoryRefused(options),
    onSome: (code) =>
      code === PairingError.Authentication
        ? new WrongSetupCode({ step: options.step })
        : new AccessoryRefused(options)
  })

/**
 * The peer answered a different step of the exchange than the one in progress.
 *
 * **Details**
 *
 * Every pairing message carries `kTLVType_State`, and it is the only thing
 * distinguishing one from another — the six share a transport, an item
 * vocabulary and, at M4 and M6, an outward shape. Checking it is what stops a
 * replayed M2 being read as an M6, and it is worth failing on rather than
 * ignoring: the items of the wrong message would either be missing, and produce
 * a confusing {@link MissingItem}, or be present with the same types and the
 * wrong meanings.
 *
 * `received` is absent when the message carried no State item at all, or carried
 * one that was not exactly one byte.
 *
 * @example
 * ```ts
 * import { Option } from "effect"
 *
 * new UnexpectedState({ step: "M4", expected: 4, received: Option.some(2) }).message
 * // => "pair-setup M4: expected State 4, got 2"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class UnexpectedState extends Data.TaggedError("PairSetupUnexpectedState")<{
  readonly step: Step
  readonly expected: number
  /** The State byte that arrived, if there was exactly one byte of it. */
  readonly received: Option.Option<number>
}> {
  /**
   * @since 0.1.0
   */
  override get message(): string {
    return `pair-setup ${this.step}: expected State ${this.expected}, got ${
      Option.match(this.received, {
        onNone: () => "no readable kTLVType_State item",
        onSome: (state) => `${state}`
      })
    }`
  }
}

/**
 * An item this step cannot proceed without is not in the message.
 *
 * **Details**
 *
 * Named by its type byte, and the name is looked up from the generated
 * vocabulary so that the message says `Salt` rather than `2`. `within`
 * distinguishes the message from the sub-TLV sealed inside it — see
 * {@link Scope}.
 *
 * **Gotchas**
 *
 * Absence and emptiness are different in TLV8 and this error is about absence
 * only. A present item of zero length is a peer saying something, and a
 * zero-length value where bytes were expected surfaces as
 * {@link MalformedItem}.
 *
 * @example
 * ```ts
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * new MissingItem({ step: "M2", within: "message", type: GeneratedPairing.TlvType.Salt }).message
 * // => "pair-setup M2: the message has no Salt item"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class MissingItem extends Data.TaggedError("PairSetupMissingItem")<{
  readonly step: Step
  readonly within: Scope
  /** The `kTLVType_` byte of the item that should have been there. */
  readonly type: number
}> {
  /**
   * @since 0.1.0
   */
  override get message(): string {
    return `pair-setup ${this.step}: the ${this.within} has no ${
      nameOf(TlvType, this.type)
    } item`
  }
}

/**
 * An item is present and is not a length this step can use.
 *
 * **Details**
 *
 * Every fixed-width value in pair-setup — a 64-byte SRP proof, a 32-byte Ed25519
 * public key, a 64-byte signature — is checked against its width before it is
 * used, and this is what that check produces. The reason to check rather than to
 * pass the bytes on is that the primitives below either reject a short key with
 * an error naming nothing in particular, or, in the case of the signature
 * verification, would happily answer `false` and let a length bug read as an
 * impostor.
 *
 * `constraint` distinguishes the two rules the format has: most widths are
 * exact, while a pairing identifier is a variable-length string with a maximum —
 * 36 bytes, the size of `HAPPairingID`, which is what an accessory can store.
 *
 * @example
 * ```ts
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * new MalformedItem({
 *   step: "M6",
 *   within: "sub-TLV",
 *   type: GeneratedPairing.TlvType.PublicKey,
 *   constraint: "exactly",
 *   expected: 32,
 *   received: 5
 * }).message
 * // => "pair-setup M6: the sub-TLV's PublicKey item is 5 bytes; expected exactly 32"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class MalformedItem extends Data.TaggedError("PairSetupMalformedItem")<{
  readonly step: Step
  readonly within: Scope
  readonly type: number
  readonly constraint: "exactly" | "at most"
  readonly expected: number
  readonly received: number
}> {
  /**
   * @since 0.1.0
   */
  override get message(): string {
    return `pair-setup ${this.step}: the ${this.within}'s ${
      nameOf(TlvType, this.type)
    } item is ${this.received} bytes; expected ${this.constraint} ${this.expected}`
  }
}

/**
 * A pairing identifier longer than an accessory can store.
 *
 * **Details**
 *
 * `HAPPairingID` is 36 bytes — a UUID in its printed form, which is what a
 * controller conventionally uses — and the ADK rejects a longer one outright
 * with `kHAPError_InvalidData`, which the controller sees as the connection
 * being dropped with no error TLV at all. Failing here instead means the
 * complaint names the identifier rather than arriving as an unexplained
 * disconnect three messages later.
 *
 * The length is in *bytes*, not characters: an identifier with a non-ASCII
 * character in it is longer than it looks.
 *
 * @example
 * ```ts
 * new IdentifierTooLong({ bytes: 40, limit: 36 }).message
 * // => "pair-setup: a pairing identifier is at most 36 bytes; this one is 40"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class IdentifierTooLong extends Data.TaggedError("PairSetupIdentifierTooLong")<{
  readonly bytes: number
  readonly limit: number
}> {
  /**
   * @since 0.1.0
   */
  override get message(): string {
    return `pair-setup: a pairing identifier is at most ${this.limit} bytes; this one is ${this.bytes}`
  }
}

/**
 * The peer signed something it could not have signed.
 *
 * **Details**
 *
 * The last check of the exchange, in both directions. Each side signs
 * `X || pairing identifier || long-term public key`, where `X` is derived from
 * the SRP shared secret with that side's own salt and info, and verifies the
 * other's. The signature is what binds the long-term key being introduced to the
 * setup code that was just proved: without it, anything that could relay the
 * SRP exchange could substitute its own long-term key and be trusted from then
 * on, and no later message would notice.
 *
 * **When to use**
 *
 * Abandon the exchange and do not store the pairing. Unlike a wrong setup code
 * this is not a user error and retrying cannot help — the peer either holds the
 * private key for the public key it sent, or it does not.
 *
 * **Gotchas**
 *
 * Reaching this at all means the sub-TLV decrypted, so the two ends do agree on
 * the SRP shared secret. That narrows the cause considerably: it is not a wrong
 * setup code, and it is not a nonce or a key derivation mismatch. What remains
 * is a genuinely bad signature, or a disagreement about what goes into the
 * signed message — its field order, or which salt and info derived the `X` in
 * front of it.
 *
 * @example
 * ```ts
 * new SignatureRejected({ step: "M6", peer: "accessory" }).message
 * // => "pair-setup M6: the accessory's signature over its own device info did not verify"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class SignatureRejected extends Data.TaggedError("PairSetupSignatureRejected")<{
  readonly step: Step
  /** Whose signature failed — the one this side received. */
  readonly peer: "controller" | "accessory"
}> {
  /**
   * @since 0.1.0
   */
  override get message(): string {
    return `pair-setup ${this.step}: the ${this.peer}'s signature over its own device info did not verify`
  }
}
