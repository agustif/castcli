/**
 * The group SRP runs in: N, g, and how wide a value is on the wire.
 *
 * Bundled into one record rather than left as three top-level constants so
 * that every function below takes the group as an argument. That is not
 * generality for its own sake — it is what lets the tests run the same code in
 * a tiny group where a value with a leading zero byte can be constructed on
 * purpose, which is the only way to demonstrate that the padding rules in
 * `Math/Pad.ts` are doing anything at all. Apple's vectors cannot show that;
 * every number in them happens to have its top byte set.
 *
 * @since 0.1.0
 */
import { Group3072 } from "../Generated/index.ts"
import { fromBigInt, pad } from "./Math/index.ts"

/**
 * A modulus, a generator, and the octet width of the modulus.
 *
 * **Details**
 *
 * `byteLength` is not independent information — it is `N` rounded up to whole
 * octets — but it is carried explicitly because it is the width every PAD() in
 * the protocol uses, and recomputing it at each of the seven call sites is
 * seven chances to compute it differently.
 *
 * @category models
 * @since 0.1.0
 */
export interface Group {
  readonly modulus: bigint
  readonly generator: bigint
  readonly byteLength: number
}

/**
 * RFC 5054's 3072-bit group, which is the one HomeKit and therefore AirPlay use.
 *
 * **Details**
 *
 * Both numbers come from `GeneratedPairing`, which extracts them from the
 * vendored RFC rather than transcribing them; `packages/airplay/test/Group3072.test.ts`
 * then checks the modulus is a safe prime, which no typo survives.
 *
 * `byteLength` is derived from the extracted digits rather than written as
 * `384`, so a group swapped underneath this constant cannot leave the padding
 * width behind pointing at the old modulus — which would produce values that
 * are individually correct and mutually incompatible.
 *
 * **Gotchas**
 *
 * RFC 5054 §4 pairs this group with SHA-1, and TLS-SRP with SHA-256. HomeKit
 * uses SHA-512 with it. The group and the hash are chosen independently and
 * this pairing is Apple's, not the RFC's — see `Hash.ts`.
 *
 * @example
 * ```ts
 * rfc5054.byteLength // => 384
 * ```
 *
 * @category constants
 * @since 0.1.0
 */
export const rfc5054: Group = {
  modulus: BigInt(`0x${Group3072.modulus}`),
  generator: BigInt(Group3072.generator),
  byteLength: Group3072.modulus.length / 2
}

/**
 * A group element as it appears in a hash: PAD()ded to the width of the modulus.
 *
 * **When to use**
 *
 * For every A, B, S and v that goes into a digest, and for the g inside the
 * multiplier `k`. Not for the g inside M1's `H(N) XOR H(g)`, which is the one
 * documented exception and encodes minimally — `Math/Pad.ts` records why, and
 * `Proof/GroupDigest.ts` is where it happens.
 *
 * @example
 * ```ts
 * encode({ modulus: 251n, generator: 5n, byteLength: 1 }, 5n) // => Uint8Array [5]
 * ```
 *
 * @category encoding
 * @since 0.1.0
 */
export const encode = (group: Group, value: bigint): Uint8Array =>
  pad(fromBigInt(value), group.byteLength)
