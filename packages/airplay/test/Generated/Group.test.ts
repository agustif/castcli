// The generated modulus, checked against arithmetic rather than against a copy.
//
// The usual way to check an extracted constant is to compare it with a second
// copy pasted in by hand — which tests that two transcriptions agree, and both
// can be wrong in the same way, because the second is usually copied from the
// first.
//
// This checks properties instead. RFC 5054's groups are *safe* primes of a
// stated size, and that is cheap to verify and impossible to satisfy by
// accident. A single flipped digit anywhere in the 768 fails primality; a
// dropped column fails the bit length; a word spliced in from the surrounding
// prose fails both.

import { assert, describe, it } from "@effect/vitest"
import { GeneratedPairing } from "@castcli/airplay"

const N = BigInt(`0x${GeneratedPairing.Group3072.modulus}`)

/** `base^exponent mod modulus`, by squaring — the numbers are 3072 bits. */
const powMod = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
  let result = 1n
  let square = base % modulus
  let remaining = exponent
  while (remaining > 0n) {
    result = (remaining & 1n) === 1n ? (result * square) % modulus : result
    square = (square * square) % modulus
    remaining >>= 1n
  }
  return result
}

/** `n - 1 = 2^power * odd`, with `odd` odd. */
const factorTwos = (n: bigint): { readonly power: number; readonly odd: bigint } => {
  let odd = n - 1n
  let power = 0
  while ((odd & 1n) === 0n) {
    odd >>= 1n
    power += 1
  }
  return { power, odd }
}

/**
 * Miller-Rabin over the first twelve primes.
 *
 * A deterministic base set would be better, but none is proven for numbers this
 * large; twelve rounds leave a failure probability under 4^-12, and what is
 * being guarded against here is a typo, not an adversary.
 */
const isProbablePrime = (n: bigint): boolean => {
  const { odd, power } = factorTwos(n)
  return [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n].every((base) => {
    // The witness sequence: x, x², x⁴, … x^(2^(power-1)), all mod n. A base
    // fails to witness compositeness when the sequence starts at 1 or reaches
    // n-1 anywhere along it.
    const sequence = Array.from({ length: power }).reduce<ReadonlyArray<bigint>>(
      (seen) => [...seen, ((seen.at(-1) ?? 1n) * (seen.at(-1) ?? 1n)) % n],
      [powMod(base, odd, n)]
    )
    return sequence[0] === 1n || sequence.slice(0, power).includes(n - 1n)
  })
}

describe("the 3072-bit group, as extracted from RFC 5054", () => {
  it("is 3072 bits", () => {
    assert.strictEqual(GeneratedPairing.Group3072.modulus.length, 768)
    assert.strictEqual(N.toString(2).length, 3072)
  })

  it("is prime", { timeout: 120_000 }, () => {
    assert.isTrue(isProbablePrime(N), "the extracted modulus is composite — a digit is wrong")
  })

  it("is a safe prime", { timeout: 120_000 }, () => {
    // (N-1)/2 prime is what makes the group's order large; SRP's security
    // argument rests on it, and it is the property most sensitive to a single
    // wrong digit anywhere in the number.
    assert.isTrue(isProbablePrime((N - 1n) / 2n), "(N-1)/2 is composite")
  })

  it("has 5 as a generator of the large subgroup", () => {
    // For a safe prime, an element generates the order-q subgroup when its
    // square is not 1. RFC 5054 states the generator is 5; this is the
    // arithmetic saying the same thing about the number actually extracted.
    const g = BigInt(GeneratedPairing.Group3072.generator)
    assert.strictEqual(g, 5n)
    assert.notStrictEqual(powMod(g, (N - 1n) / 2n, N), 1n)
  })
})
