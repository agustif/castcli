/**
 * A number and its big-endian bytes.
 *
 * SRP is arithmetic that travels as octet strings. Everything on the wire is
 * big-endian — that is stated once in RFC 2945 and then assumed everywhere —
 * so this is the single place the two representations meet, and the single
 * place a byte-order mistake could be made.
 *
 * Deliberately *minimal* on the way out: `fromBigInt` produces the shortest
 * big-endian encoding, with no leading zero bytes. Fixed-width encoding is a
 * separate decision, made by `Pad` and applied by `Group.encode`, because the
 * whole difficulty in this protocol is that the two forms are wanted in
 * different places — see the comment in `Srp/Proof/GroupDigest.ts`.
 *
 * @since 0.1.0
 */
import { Encoding } from "effect"

/**
 * The number a big-endian octet string stands for.
 *
 * **Details**
 *
 * Leading zeros are simply weight-zero digits, so this is insensitive to
 * padding: `toBigInt` of a 384-byte value and of its minimal form agree. That
 * asymmetry is the reason padding only ever matters on the way *into* a hash,
 * never on the way into the arithmetic.
 *
 * **Gotchas**
 *
 * An empty array decodes as `0n`. That is what OpenSSL's `BN_bin2bn` does and
 * what the protocol means by an empty field, but it also means a truncated read
 * decodes successfully rather than failing — callers that care (the public-key
 * checks in `Client` and `Server`) test the value against zero explicitly.
 *
 * @example
 * ```ts
 * toBigInt(Uint8Array.from([0x01, 0x00])) // => 256n
 * ```
 *
 * @category conversions
 * @since 0.1.0
 */
export const toBigInt = (bytes: Uint8Array): bigint =>
  bytes.length === 0 ? 0n : BigInt(`0x${Encoding.encodeHex(bytes)}`)

/**
 * The shortest big-endian octet string standing for a number.
 *
 * **Details**
 *
 * `0n` encodes as a single zero byte rather than as nothing. OpenSSL's
 * `BN_bn2bin` returns zero bytes for zero; a single zero is the friendlier
 * choice here because every consumer immediately pads to the group width, where
 * the two agree, and returning an empty array from something named "to bytes"
 * has surprised every reader who has met it.
 *
 * **Gotchas**
 *
 * Only defined for non-negative values. A negative number would produce a
 * leading `"-"` and decode as garbage. Nothing calls it with one — every value
 * that could go negative (`B - k*g^x` in the client's premaster secret) is
 * normalised back into `[0, N)` before it reaches here — but the constraint is
 * worth stating because the failure would be silent.
 *
 * @example
 * ```ts
 * fromBigInt(256n) // => Uint8Array [0x01, 0x00]
 * ```
 *
 * @category conversions
 * @since 0.1.0
 */
export const fromBigInt = (value: bigint): Uint8Array => {
  const digits = value.toString(16)
  const even = digits.length % 2 === 0 ? digits : `0${digits}`
  return Uint8Array.from(
    { length: even.length / 2 },
    (_, index) => Number.parseInt(even.slice(index * 2, index * 2 + 2), 16)
  )
}
