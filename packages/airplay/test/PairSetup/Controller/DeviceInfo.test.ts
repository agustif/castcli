// The signed message: three fields, no separators, and one that varies.
//
// There is no published vector for this, and it is a concatenation, so what is
// worth asserting is not the bytes of any one example but the property that
// makes the concatenation safe: the variable-length field sits between two
// fixed-width ones, so no two different (identifier, key) pairs can produce the
// same signed message. If the identifier were last, an identifier ending in a
// key prefix and a shorter identifier with a longer key would sign identically
// — and a signature over the wrong division of the same bytes is exactly the
// substitution the signature exists to prevent.

import { assert, describe, it } from "@effect/vitest"
import { Redacted } from "effect"
import { deviceInfo } from "../../../src/PairSetup/Controller/DeviceInfo.ts"

const bytes = (length: number, seed: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index + seed) & 0xff)

const X = Redacted.make(bytes(32, 1))
const KEY = bytes(32, 200)

describe("deviceInfo", () => {
  it("is the three fields end to end, in that order", () => {
    const identifier = new TextEncoder().encode("AA:BB:CC:DD:EE:FF")
    const info = deviceInfo({ x: X, identifier, publicKey: KEY })

    assert.strictEqual(info.length, 32 + identifier.length + 32)
    assert.deepStrictEqual(info.slice(0, 32), Redacted.value(X))
    assert.deepStrictEqual(info.slice(32, 32 + identifier.length), identifier)
    assert.deepStrictEqual(info.slice(32 + identifier.length), KEY)
  })

  it("cannot be made to collide by moving bytes between the two variable ends", () => {
    // The property, stated as the pair that would collide if the identifier
    // were at the end. Here they differ, because the identifier is surrounded.
    const shorter = deviceInfo({
      x: X,
      identifier: new TextEncoder().encode("device"),
      publicKey: KEY
    })
    const longer = deviceInfo({
      x: X,
      identifier: new TextEncoder().encode("device0"),
      publicKey: KEY
    })
    assert.notDeepEqual(shorter, longer)
    assert.notStrictEqual(shorter.length, longer.length)
  })

  it("changes when the derived secret changes, which is what binds it to the exchange", () => {
    // Same identity, different exchange: a signature from one pairing must not
    // verify in another, and this is the field that stops it.
    const identifier = new TextEncoder().encode("device")
    assert.notDeepEqual(
      deviceInfo({ x: X, identifier, publicKey: KEY }),
      deviceInfo({ x: Redacted.make(bytes(32, 2)), identifier, publicKey: KEY })
    )
  })

  it("copies rather than viewing, so a later write cannot change what was signed", () => {
    const identifier = Uint8Array.of(1, 2, 3)
    const info = deviceInfo({ x: X, identifier, publicKey: KEY })
    identifier[0] = 9
    assert.strictEqual(info[32], 1)
  })
})
