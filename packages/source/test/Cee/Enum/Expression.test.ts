// What a C compiler would fold an initialiser to.

import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { Expression } from "../../../src/Cee/Enum/index.ts"

const { valueOf } = Expression

const value = (expression: string) => Option.getOrElse(valueOf(expression), () => Number.NaN)

describe("Cee Expression.valueOf", () => {
  it("reads the literal bases C writes", () => {
    assert.strictEqual(value("0x13"), 19)
    assert.strictEqual(value("19"), 19)
    assert.strictEqual(value("0b10011"), 19)
    // 010 is eight to a compiler. Anything that calls `Number` on it gets ten,
    // and a constant that is wrong by two has no other symptom.
    assert.strictEqual(value("010"), 8)
    assert.strictEqual(value("0"), 0)
  })

  it("ignores the integer suffixes, which say type rather than value", () => {
    assert.strictEqual(value("0x13U"), 19)
    assert.strictEqual(value("19UL"), 19)
    assert.strictEqual(value("19ull"), 19)
  })

  it("evaluates the shifts a flags enum is written with", () => {
    assert.strictEqual(value("1U << 4U"), 16)
    assert.strictEqual(value("1U << 24U"), 16777216)
  })

  it("keeps a shift past bit 30 unsigned", () => {
    // JavaScript's `<<` truncates to a signed 32-bit integer, so `1 << 31` is
    // -2147483648. A negative flag value compiles into generated output,
    // compares unequal to everything a device sends, and says nothing about
    // why — so the shift is arithmetic here rather than bitwise.
    assert.strictEqual(value("1U << 31U"), 2147483648)
  })

  it("respects parentheses and precedence", () => {
    assert.strictEqual(value("(1 << 4) | 1"), 17)
    assert.strictEqual(value("1 | 1 << 4"), 17)
    assert.strictEqual(value("2 + 3 * 4"), 14)
    assert.strictEqual(value("(2 + 3) * 4"), 20)
  })

  it("is left-associative, as C is", () => {
    assert.strictEqual(value("8 - 2 - 1"), 5)
    assert.strictEqual(value("16 / 4 / 2"), 2)
  })

  it("reads unary operators", () => {
    assert.strictEqual(value("-1"), -1)
    assert.strictEqual(value("~0"), 4294967295)
  })

  it("refuses what it cannot evaluate, rather than guessing", () => {
    // Each of these would be a silently wrong or silently missing constant if
    // the evaluator returned a number anyway. The identifier case is the one
    // that matters most: a parser that skipped the token it did not recognise
    // would confidently evaluate the fragment that was left.
    assert.isTrue(Option.isNone(valueOf("kOther_Constant")))
    assert.isTrue(Option.isNone(valueOf("kOther_Constant | 1")))
    assert.isTrue(Option.isNone(valueOf("sizeof(int)")))
    assert.isTrue(Option.isNone(valueOf("'a'")))
    assert.isTrue(Option.isNone(valueOf("1.5")))
    assert.isTrue(Option.isNone(valueOf("")))
    assert.isTrue(Option.isNone(valueOf("(1")))
    assert.isTrue(Option.isNone(valueOf("1 +")))
  })
})
