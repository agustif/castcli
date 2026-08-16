/**
 * The two ways an SRP exchange ends badly, which are not the same way.
 *
 * A rejected proof and a malformed value look identical from a distance — both
 * are "pairing failed" — and conflating them is how an implementation bug gets
 * reported as a wrong PIN for a month. They are kept apart here because the
 * responses differ: a rejected proof is the user mistyping the code on the
 * television and is answered with `PairingError.Authentication` and a retry; a
 * public key of zero is a peer that is broken or hostile and is answered by
 * abandoning the exchange.
 *
 * Both are `Schema.TaggedError`, so they appear in the effect's error channel
 * and a caller must say which of the two it is handling.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * The other side's proof did not match the one we computed.
 *
 * **Details**
 *
 * `proof` says which direction failed, and the distinction matters. An `M1`
 * rejection is the server telling the client its password was wrong — the
 * ordinary case, and the only one a user ever causes. An `M2` rejection is the
 * *client* discovering that the server could not prove it knew the verifier,
 * which is not a typo: it is an accessory that does not have the credential it
 * claims, or something in the middle. A client that treats M2 as "try again"
 * has turned a detected impersonation into a retry loop.
 *
 * **Gotchas**
 *
 * Carries nothing but the direction — no expected value, no received value.
 * That is deliberate: an error that logs the proof it expected hands an
 * attacker the answer through whatever channel the log lands in.
 *
 * @example
 * ```ts
 * new ProofRejected({ proof: "M1" }).message // => "SRP: the M1 proof did not verify"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class ProofRejected extends Schema.TaggedError<ProofRejected>()(
  "SrpProofRejected",
  { proof: Schema.Literals(["M1", "M2"]) }
) {
  override get message(): string {
    return `SRP: the ${this.proof} proof did not verify`
  }
}

/**
 * A public key that the protocol requires be rejected before it is used.
 *
 * **Details**
 *
 * RFC 5054 §2.5.4 has both sides abort when the other's public value is
 * congruent to zero modulo N. It is worth stating what goes wrong without the
 * check, because "validate your inputs" understates it: `A ≡ 0` makes the
 * server's premaster secret `(A * v^u)^b ≡ 0` regardless of the verifier, so an
 * attacker who never knew the password derives the same session key the server
 * does, and the exchange completes. The check is not hygiene; it is the
 * difference between authentication and none.
 *
 * `side` names whose key was bad — `"client"` for A, `"server"` for B.
 *
 * @example
 * ```ts
 * new InvalidPublicKey({ side: "client" }).message
 * // => "SRP: the client's public key is congruent to zero modulo N"
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export class InvalidPublicKey extends Schema.TaggedError<InvalidPublicKey>()(
  "SrpInvalidPublicKey",
  { side: Schema.Literals(["client", "server"]) }
) {
  override get message(): string {
    return `SRP: the ${this.side}'s public key is congruent to zero modulo N`
  }
}
