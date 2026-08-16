// S from the accessory's side, against Apple's published S.
//
// This is the assertion the vectors were extracted for. Every input —
// `A`, `v`, `u`, `b` — is Apple's, and so is the expected output, so nothing
// here is derived from anything else in this codebase.

import { assert, describe, it } from "@effect/vitest"
import { SrpVectors } from "../../../src/Generated/index.ts"
import * as Group from "../../../src/Srp/Group.ts"
import { toBigInt } from "../../../src/Srp/Math/index.ts"
import { fromVerifier } from "../../../src/Srp/Premaster/FromVerifier.ts"

const group = Group.rfc5054

describe("fromVerifier", () => {
  it("reproduces Apple's premaster secret", () => {
    const S = fromVerifier(group, {
      clientPublic: toBigInt(SrpVectors.A),
      verifier: toBigInt(SrpVectors.v),
      scrambler: toBigInt(SrpVectors.u),
      privateKey: toBigInt(SrpVectors.b)
    })
    assert.strictEqual(S, toBigInt(SrpVectors.S))
  })

  it("encodes back to the published 384 octets", () => {
    // The number matching is the arithmetic; this is the wire form, and it is
    // a separate claim — a correct S written out minimally would be 384 octets
    // only by luck.
    const S = fromVerifier(group, {
      clientPublic: toBigInt(SrpVectors.A),
      verifier: toBigInt(SrpVectors.v),
      scrambler: toBigInt(SrpVectors.u),
      privateKey: toBigInt(SrpVectors.b)
    })
    assert.deepStrictEqual(Group.encode(group, S), SrpVectors.S)
  })

  it("collapses to zero when A is congruent to zero, which is why callers must check", () => {
    // The reason `Errors.InvalidPublicKey` exists. With A ≡ 0 the secret is 0
    // for every verifier and every b, so a peer that never knew the password
    // derives the same key the accessory does.
    const S = fromVerifier(group, {
      clientPublic: group.modulus,
      verifier: toBigInt(SrpVectors.v),
      scrambler: toBigInt(SrpVectors.u),
      privateKey: toBigInt(SrpVectors.b)
    })
    assert.strictEqual(S, 0n)
  })
})
