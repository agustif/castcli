// Matching a C name only where a C name can be.

import { assert, describe, it } from "@effect/vitest"
import { startingAt, whole } from "../../src/Cee/Identifier.ts"

describe("Cee Identifier.whole", () => {
  it("does not match a longer name that contains it", () => {
    const salt = new RegExp(whole("salt"))
    // Both directions matter: `hkdf_salt` extends it on the left and
    // `salt_len` on the right, and either one silently answers the wrong
    // question with a value of exactly the right kind.
    assert.isFalse(salt.test("hkdf_salt"))
    assert.isFalse(salt.test("salt_len"))
    assert.isTrue(salt.test("static const uint8_t salt[]"))
  })
})

describe("Cee Identifier.startingAt", () => {
  it("leaves the right edge open, so a family prefix continues into the name", () => {
    const family = new RegExp(`${startingAt("kThing_")}(\\w+)`)
    assert.strictEqual(family.exec("kThing_First")?.[1], "First")
    // Still closed on the left: a prefix embedded in a longer identifier is not
    // a member of the family.
    assert.isNull(family.exec("mykThing_First"))
  })
})

describe("Cee Identifier", () => {
  it("treats regular-expression punctuation in a name as literal text", () => {
    // A caller can pass anything. Unescaped, `a.c` would match `abc` — a
    // pattern that finds the wrong declaration rather than raising an error,
    // which is the failure mode with no symptom.
    assert.isFalse(new RegExp(whole("a.c")).test("abc"))
    assert.isTrue(new RegExp(whole("a.c")).test("x = a.c;"))
  })
})
