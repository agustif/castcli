/**
 * The three ways pair-verify ends badly that are not a broken host and not a
 * malformed message.
 *
 * Two other failures already have types and are deliberately not restated here.
 * A message that is not the shape the codec describes fails with Effect's own
 * `SchemaError`, naming the item that was missing or the wrong length. A sealed
 * sub-TLV whose tag does not verify fails with `Suite.ForgedFrame`, naming the
 * nonce it was opened under. Both of those are about the *bytes*; what follows
 * is about the *peer*, and keeping the two apart is the difference between "the
 * device is speaking a dialect we do not" and "the device is not who it says it
 * is".
 *
 * That distinction is the whole point of pair-verify. An exchange that reaches a
 * shared secret without checking a signature completes just as happily against
 * an impostor, and every one of these errors marks a place where it must not.
 *
 * @since 0.1.0
 */
import { Option, Schema } from "effect"
import { PairingError, PairingErrorFromWire } from "../Generated/index.ts"

/**
 * The peer's signature over the ephemeral keys did not verify.
 *
 * **Details**
 *
 * This is the error the whole exchange exists to be able to raise. Both sides
 * sign their own ephemeral public key, their pairing identifier and the peer's
 * ephemeral public key with the long-term Ed25519 key the other learned during
 * pair-setup; a signature that does not verify under that key means the peer
 * does not hold the private half. It is a stranger, or a machine in the middle
 * relaying an exchange it cannot sign for.
 *
 * `side` says which role's signature failed, and the two are not
 * interchangeable. `"accessory"` is a controller discovering that the
 * television it dialled is not the one it paired with — the case that motivates
 * pair-verify. `"controller"` is an accessory refusing a caller, which is the
 * ordinary way an unpaired or removed controller is turned away and which HAP
 * answers with `kHAPPairingError_Authentication`.
 *
 * **Gotchas**
 *
 * Never retry on this. The signature covers two ephemeral keys that will not
 * exist again, so a second attempt with the same transcript fails identically,
 * and a second attempt with a *fresh* transcript against the same peer is a
 * retry loop against something that has already failed to prove who it is.
 *
 * Carries no key and no signature. The values are public, but an error that
 * quoted them would be quoted back into a log where the interesting question —
 * which side, and therefore who is being lied to — is already answered by the
 * tag.
 *
 * @example
 * ```ts
 * new SignatureRejected({ side: "accessory" }).message
 * // => "pair-verify: the accessory's signature over its ephemeral key did not verify"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class SignatureRejected extends Schema.TaggedError<SignatureRejected>()(
  "PairVerifySignatureRejected",
  { side: Schema.Literals(["controller", "accessory"]) }
) {
  override get message(): string {
    return `pair-verify: the ${this.side}'s signature over its ephemeral key did not verify`
  }
}

/**
 * The peer named a pairing identifier we have no long-term key for.
 *
 * **Details**
 *
 * Raised before any signature is checked, because there is nothing to check it
 * against. On the accessory this is a controller that was never paired or whose
 * pairing has been removed. On the controller it is an accessory answering with
 * an identifier other than the one pair-setup recorded — a different device on
 * the same address, or the same device factory-reset and re-paired to someone
 * else.
 *
 * **Gotchas**
 *
 * Distinct from {@link SignatureRejected} on purpose, even though both mean
 * "not a peer we trust". Conflating them costs a real diagnosis: an unknown
 * identifier is a pairing that needs to be made again, and a rejected signature
 * with a *known* identifier is a key that does not match one we already hold,
 * which pair-setup will not fix.
 *
 * @example
 * ```ts
 * new PeerUnknown({ identifier: "3E:8F:...", side: "controller" }).message
 * // => "pair-verify: no pairing for the controller \"3E:8F:...\""
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class PeerUnknown extends Schema.TaggedError<PeerUnknown>()(
  "PairVerifyPeerUnknown",
  {
    /** The identifier the peer sent, as it decoded. */
    identifier: Schema.String,
    /** Which role sent it. */
    side: Schema.Literals(["controller", "accessory"])
  }
) {
  override get message(): string {
    return `pair-verify: no pairing for the ${this.side} ${JSON.stringify(this.identifier)}`
  }
}

/** The generated vocabulary, reversed, so an error can name a code. */
const nameOf = (code: number): string =>
  Option.match(
    Option.fromUndefinedOr(
      Object.entries(PairingError).find(([, value]) => value === code)
    ),
    { onNone: () => String(code), onSome: ([name]) => name }
  )

/**
 * The peer answered with `kTLVType_Error` instead of the message we expected.
 *
 * **Details**
 *
 * HAP's refusal is a response carrying only a State and an Error item, and it
 * can arrive in place of M2 or of M4. It is not a transport failure and not a
 * malformed message: the peer understood the request perfectly and declined it,
 * most often with `Authentication` because our M3 signature did not verify on
 * *its* side — which is to say, this is the far end's {@link SignatureRejected}
 * arriving as a byte.
 *
 * **Gotchas**
 *
 * `Backoff` and `MaxTries` mean the device is rate-limiting; retrying
 * immediately is how a controller earns a longer lockout. `Authentication`
 * after a pairing that used to work usually means the accessory was reset and
 * no longer holds our long-term key — pair-setup, not another pair-verify.
 *
 * @example
 * ```ts
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * new Refused({ error: GeneratedPairing.PairingError.Authentication }).message
 * // => "pair-verify: the peer refused with Authentication (2)"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class Refused extends Schema.TaggedError<Refused>()(
  "PairVerifyRefused",
  {
    /**
     * The code the peer sent, decoded against the generated vocabulary so that
     * a value HAP does not define is a decoding failure rather than a number
     * nobody can look up.
     */
    error: PairingErrorFromWire
  }
) {
  override get message(): string {
    return `pair-verify: the peer refused with ${nameOf(this.error)} (${this.error})`
  }
}
