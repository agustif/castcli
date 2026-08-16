// C's string escapes, both ways.

import { assert, describe, it } from "@effect/vitest"
import { escape, unescape } from "../../../src/Cee/Literal/Escape.ts"

describe("Cee Escape.unescape", () => {
  it("resolves the named escapes", () => {
    assert.strictEqual(unescape("a\\nb\\tc\\\\d\\\"e"), "a\nb\tc\\d\"e")
  })

  it("resolves hexadecimal and octal escapes", () => {
    assert.strictEqual(unescape("\\x41\\x42"), "AB")
    assert.strictEqual(unescape("\\101"), "A")
    // `\0` is octal zero, and a salt may legitimately contain one. Left as two
    // characters it is two extra bytes of key material and a key that differs
    // from the device's for no visible reason.
    assert.strictEqual(unescape("a\\0b"), "a\u0000b")
  })

  it("passes an unknown escape through as the character, as C does", () => {
    assert.strictEqual(unescape("\\q"), "q")
  })

  it("leaves a string with no escapes exactly as it is", () => {
    assert.strictEqual(unescape("Pair-Setup-Encrypt-Salt"), "Pair-Setup-Encrypt-Salt")
  })
})

describe("Cee Escape.escape", () => {
  it("escapes only what has to be escaped", () => {
    // An ordinary salt comes back out looking exactly as it does in the
    // source, which is what makes an encode of a decode readable in a diff.
    assert.strictEqual(escape("Pair-Setup-Encrypt-Salt"), "Pair-Setup-Encrypt-Salt")
    assert.strictEqual(escape("a\nb\"c\\d"), "a\\nb\\\"c\\\\d")
  })

  it("round-trips through unescape", () => {
    const awkward = "a\nb\tc\"d\\e f"
    assert.strictEqual(unescape(escape(awkward)), awkward)
  })
})
