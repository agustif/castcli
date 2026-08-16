// Exponentiation, checked against arithmetic rather than against itself.
//
// The temptation with a square-and-multiply is to check it against a table of
// values produced by the same square-and-multiply. These check properties the
// implementation cannot satisfy by accident: agreement with the naive `**`
// where the naive form is small enough to compute, and Fermat's little theorem
// in the real 3072-bit group, which a wrong loop bound or a missed reduction
// cannot pass.

import { assert, describe, it } from "@effect/vitest"
import { modPow } from "../../../src/Srp/Math/ModPow.ts"
import * as Group from "../../../src/Srp/Group.ts"

describe("modPow", () => {
  it("agrees with direct exponentiation wherever direct exponentiation fits", () => {
    // Every base and exponent from 0 to 20 in a small prime group. The naive
    // form is the definition; this asserts the fast form computes the same
    // thing, over a range wide enough to include the edges the bit loop gets
    // wrong — exponent 0, exponent 1, and the powers of two either side of a
    // carry.
    const modulus = 251n
    const pairs = Array.from({ length: 21 }, (_unusedBase, base) =>
      Array.from({ length: 21 }, (_unusedExponent, exponent) => ({
        base: BigInt(base),
        exponent: BigInt(exponent)
      }))).flat()
    const wrong = pairs.filter(({ base, exponent }) =>
      modPow(base, exponent, modulus) !== (base ** exponent) % modulus)
    assert.deepStrictEqual(wrong, [], "fast and naive exponentiation disagree")
  })

  it("is 1 for a zero exponent, whatever the base", () => {
    assert.strictEqual(modPow(0n, 0n, 251n), 1n)
    assert.strictEqual(modPow(250n, 0n, 251n), 1n)
  })

  it("satisfies Fermat's little theorem in the real group", { timeout: 60_000 }, () => {
    // g^(N-1) ≡ 1 mod N for prime N. Nothing but a correct 3072-bit modular
    // exponentiation passes this: an unreduced intermediate would not finish,
    // and an off-by-one in the bit loop gives g^(N-2) or g^N, neither of which
    // is 1.
    const { generator, modulus } = Group.rfc5054
    assert.strictEqual(modPow(generator, modulus - 1n, modulus), 1n)
  })
})
