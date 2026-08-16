/**
 * Pulling out an item a step cannot do without, and checking its size.
 *
 * Three functions, and the second and third are the ones that matter. Every
 * value pair-setup exchanges past the salt has a width fixed by the primitive
 * that consumes it — a 64-byte SRP proof, a 32-byte Ed25519 public key, a
 * 64-byte signature — and handing a wrong-sized one onward produces a failure
 * that names nothing useful. A short public key reaches `Suite.ed25519Verify`,
 * which refuses it as a bad argument from inside the cryptography; a short
 * *signature* would be worse if it were allowed through, because a verification
 * that answered `false` reads as an impostor rather than as a truncated message.
 *
 * So the widths are checked here, once, against the sizes in
 * `packages/airplay/vendor/HAPCrypto.h`, and the error names the item and both
 * lengths.
 *
 * @since 0.1.0
 */
import { Effect, Option } from "effect"
import { find, type Item } from "../../../Tlv8/index.ts"
import { MalformedItem, MissingItem, type Scope, type Step } from "../../Errors.ts"

/** What every function here is told about where it is looking. */
interface Where {
  readonly items: ReadonlyArray<Item>
  readonly step: Step
  /** The message, or the sub-TLV sealed inside it. */
  readonly within: Scope
  /** The `kTLVType_` byte to look for. */
  readonly type: number
}

/**
 * The value of an item that has to be there, of whatever length.
 *
 * **When to use**
 *
 * For the values with no fixed width: the SRP salt, the accessory's public key
 * — which the ADK sends with its leading zero bytes stripped, so its length
 * varies by message — and the sealed sub-TLV, whose length is whatever it
 * contains.
 *
 * @example
 * ```ts
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * declare const items: ReadonlyArray<Item>
 * const salt = required({ items, step: "M2", within: "message", type: GeneratedPairing.TlvType.Salt })
 * ```
 *
 * @category decoding
 * @since 0.1.0
 */
export const required = (
  where: Where
): Effect.Effect<Uint8Array, MissingItem> =>
  Option.match(find(where.items, where.type), {
    onNone: () =>
      Effect.fail(
        new MissingItem({ step: where.step, within: where.within, type: where.type })
      ),
    onSome: (value) => Effect.succeed(value)
  })

/**
 * The value of an item that has to be there and has to be exactly this long.
 *
 * **Gotchas**
 *
 * The length is the length *after* fragments have been rejoined, which they have
 * been if the items came out of the `Tlv8.Items` codec. On raw fragments a
 * 384-byte value looks like 255 bytes and this rejects it, which is the right
 * answer to the wrong question — the mistake was reading the payload without the
 * codec.
 *
 * @example
 * ```ts
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * declare const items: ReadonlyArray<Item>
 * // SRP_PROOF_BYTES.
 * const m2 = exactly({
 *   items,
 *   step: "M4",
 *   within: "message",
 *   type: GeneratedPairing.TlvType.Proof,
 *   bytes: 64
 * })
 * ```
 *
 * @category decoding
 * @since 0.1.0
 */
export const exactly = (
  where: Where & { readonly bytes: number }
): Effect.Effect<Uint8Array, MalformedItem | MissingItem> =>
  Effect.flatMap(required(where), (value) =>
    value.length === where.bytes ? Effect.succeed(value) : Effect.fail(
      new MalformedItem({
        step: where.step,
        within: where.within,
        type: where.type,
        constraint: "exactly",
        expected: where.bytes,
        received: value.length
      })
    ))

/**
 * The value of an item that has to be there and no longer than this.
 *
 * **When to use**
 *
 * For pairing identifiers, which are the one variable-length value with a limit:
 * an accessory stores 36 bytes of one (`HAPPairingID`) and truncates or refuses
 * anything longer. Checking it on the way in means a pairing this controller
 * stores is one the accessory could have stored too.
 *
 * @example
 * ```ts
 * import { GeneratedPairing } from "@castcli/airplay"
 *
 * declare const items: ReadonlyArray<Item>
 * const identifier = atMost({
 *   items,
 *   step: "M6",
 *   within: "sub-TLV",
 *   type: GeneratedPairing.TlvType.Identifier,
 *   bytes: 36
 * })
 * ```
 *
 * @category decoding
 * @since 0.1.0
 */
export const atMost = (
  where: Where & { readonly bytes: number }
): Effect.Effect<Uint8Array, MalformedItem | MissingItem> =>
  Effect.flatMap(required(where), (value) =>
    value.length <= where.bytes ? Effect.succeed(value) : Effect.fail(
      new MalformedItem({
        step: where.step,
        within: where.within,
        type: where.type,
        constraint: "at most",
        expected: where.bytes,
        received: value.length
      })
    ))
