/**
 * PAD() — left-zero-extend an octet string to a fixed width.
 *
 * Six lines of code with its own file, because the question it answers is the
 * one this whole module exists to settle. SRP hashes numbers, and a number has
 * two byte encodings: the shortest one, and one padded out to the width of the
 * modulus. They differ only when the top byte happens to be zero, which for a
 * uniformly random 384-byte value is one time in 256. Choose wrong and the
 * implementation interoperates perfectly for weeks and then rejects a pairing,
 * and the next attempt succeeds.
 *
 * So the choice is not made by reading; it is made by reproducing Apple's
 * vectors from `packages/airplay/vendor/HAPCryptoTest.c`, one variant at a
 * time. The record of what won:
 *
 * | value          | hashed as        | how it was settled                     |
 * | -------------- | ---------------- | -------------------------------------- |
 * | g, inside k    | PAD, 384 bytes   | vectors: only this reproduces B        |
 * | g, inside M1   | 1 byte, `05`     | vectors: only this reproduces M1       |
 * | N              | 384 bytes        | N *is* 384 bytes; nothing to decide     |
 * | A, B           | PAD, 384 bytes   | `HAPCrypto.h` buffer widths (see below)|
 * | S              | PAD, 384 bytes   | `HAPCrypto.h` buffer widths (see below)|
 * | v              | PAD, 384 bytes   | `HAPCryptoTest.c`'s `test_bn_pad`      |
 * | salt, username | verbatim          | not numbers                            |
 *
 * The first two rows are the surprise, and they are the reason this file is not
 * a footnote. The *same generator*, in the *same exchange*, is hashed padded to
 * 384 bytes when it forms the multiplier `k = H(N | PAD(g))` and as the single
 * byte `05` when it forms `H(N) XOR H(g)` inside M1. Both were tried both ways
 * against the vectors; each has exactly one variant that reproduces Apple's
 * output and the other produces a value that is wrong and looks fine. The
 * reason is historical rather than principled — `k` follows RFC 5054 §2.6,
 * which introduced PAD() precisely to fix a length-extension asymmetry, and M1
 * follows RFC 2945 §3, which predates it and hashes `g` as it is written.
 *
 * The A/B/S rows could not be settled by the vectors, and it is worth being
 * exact about why: in Apple's vector A, B, S and N all happen to have their top
 * byte set (`fa`, `40`, `f1`, `ff`), so padded and minimal encodings are the
 * same bytes and every variant passes. They are settled instead by the C API in
 * `packages/airplay/vendor/HAPCrypto.h`, which is evidence of a different kind:
 * `HAP_srp_scrambling_parameter` takes `const uint8_t pub_a[SRP_PUBLIC_KEY_BYTES]`
 * — a fixed 384-byte buffer, with no length alongside it — so a shorter
 * encoding cannot be expressed at that boundary at all. `HAPCryptoTest.c`
 * removes the last doubt with a test whose only purpose is this, `test_bn_pad`,
 * commented "this trips an assert if BN_bn2bin is used in the OpenSSL backend
 * because the verifier has to be padded to use the full SRP_VERIFIER_BYTES
 * width". `BN_bn2bin` is exactly the minimal encoding. Apple wrote a test to
 * prohibit it.
 *
 * @since 0.1.0
 */

/**
 * `bytes`, left-extended with zeros to exactly `width` octets.
 *
 * **Details**
 *
 * A new array every time; the input is never touched. The result always has
 * length `width`, which is what makes it safe to feed straight into a digest
 * with no separator — every field in these hashes is either fixed-width or the
 * last one.
 *
 * **Gotchas**
 *
 * An input longer than `width` is truncated from the *left*, keeping the
 * low-order octets — the arithmetic reading of "the value modulo 2^(8*width)",
 * rather than a silent zero-fill. It should never happen: every caller has
 * already reduced modulo N, and N is `width` octets. If it does, the value was
 * not reduced, and losing the top bytes is the loud version of that mistake.
 *
 * @example
 * ```ts
 * pad(Uint8Array.from([0x05]), 4) // => Uint8Array [0, 0, 0, 5]
 * ```
 *
 * @category encoding
 * @since 0.1.0
 */
export const pad = (bytes: Uint8Array, width: number): Uint8Array => {
  const offset = width - bytes.length
  return Uint8Array.from(
    { length: width },
    (_, index) => index < offset ? 0 : bytes[index - offset] ?? 0
  )
}
