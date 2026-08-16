// The DER templates, checked against DER that Node wrote.
//
// These twelve and sixteen bytes are the most dangerous constants in the
// package: an object identifier off by one digit still parses, still round-trips
// against our own code, and is rejected by every real device. Checking them by
// importing a key and exporting it again would prove nothing, because both
// directions would use the same wrong template.
//
// So this asks Node to generate a key pair and write the structures itself, then
// checks that what it wrote begins with exactly our constant. Node's encoder is
// an independent implementation of RFC 8410 — it has never seen our bytes — so
// agreement is evidence rather than tautology.

import { assert, describe, it } from "@effect/vitest"
import { Match } from "effect"
import * as NodeCrypto from "node:crypto"
import type { Curve } from "../../../src/NodeSuite/Der/Curve.ts"
import { Ed25519, X25519 } from "../../../src/NodeSuite/Der/Curve.ts"
import { Sizes } from "../../../src/Suite/Sizes.ts"

/**
 * Node's own encoding of a fresh key pair for this curve.
 *
 * The two branches exist because `generateKeyPairSync` is overloaded on a string
 * literal, and a union does not select an overload. Written as a `Match` rather
 * than an assertion, so adding a third curve to `Curve.ts` fails to compile here
 * instead of silently skipping its templates.
 */
const generated = (curve: Curve) => {
  const pair = Match.value(curve.nodeType).pipe(
    Match.when("ed25519", () => NodeCrypto.generateKeyPairSync("ed25519")),
    Match.when("x25519", () => NodeCrypto.generateKeyPairSync("x25519")),
    Match.exhaustive
  )
  return {
    spki: Uint8Array.from(pair.publicKey.export({ format: "der", type: "spki" })),
    pkcs8: Uint8Array.from(pair.privateKey.export({ format: "der", type: "pkcs8" }))
  }
}

/** How many of `left`'s bytes differ from `right`'s at the same position. */
const differences = (left: Uint8Array, right: Uint8Array): number =>
  left.reduce((count, byte, index) => count + (byte === right[index] ? 0 : 1), 0)

describe.each([
  ["Ed25519", Ed25519],
  ["X25519", X25519]
])("the %s DER envelope", (_name, curve) => {
  it("is exactly what Node writes in front of a public key", () => {
    const { spki } = generated(curve)
    assert.strictEqual(spki.length, curve.spkiPrefix.length + Sizes.PUBLIC_KEY)
    assert.deepStrictEqual(spki.subarray(0, curve.spkiPrefix.length), curve.spkiPrefix)
  })

  it("is exactly what Node writes in front of a private key", () => {
    // Including the doubled OCTET STRING header — `04 22 04 20` — which is the
    // part of RFC 8410 that reads like a typo and is not.
    const { pkcs8 } = generated(curve)
    assert.strictEqual(pkcs8.length, curve.pkcs8Prefix.length + Sizes.PRIVATE_KEY)
    assert.deepStrictEqual(pkcs8.subarray(0, curve.pkcs8Prefix.length), curve.pkcs8Prefix)
  })
})

describe("the two curves", () => {
  it("differ by exactly the one byte of the object identifier", () => {
    // 1.3.101.112 against 1.3.101.110. If a future edit copies one template to
    // make the other and forgets this byte, the suite quietly signs with a key
    // agreement algorithm's identifier — which OpenSSL accepts on import and no
    // accessory accepts on the wire.
    assert.strictEqual(differences(Ed25519.spkiPrefix, X25519.spkiPrefix), 1)
    assert.strictEqual(differences(Ed25519.pkcs8Prefix, X25519.pkcs8Prefix), 1)
  })
})
