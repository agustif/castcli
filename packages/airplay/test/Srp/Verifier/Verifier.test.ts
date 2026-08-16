// v, byte for byte against Apple's.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SrpVectors } from "../../../src/Generated/index.ts"
import * as Group from "../../../src/Srp/Group.ts"
import { verifier } from "../../../src/Srp/Verifier/Verifier.ts"

const group = Group.rfc5054

describe("verifier", () => {
  it.effect("reproduces Apple's verifier exactly", () =>
    Effect.gen(function*() {
      const v = yield* verifier(group, {
        username: "alice",
        password: "password123",
        salt: SrpVectors.salt
      })
      assert.deepStrictEqual(v, SrpVectors.v)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("is 384 octets, which is the thing test_bn_pad exists to enforce", () =>
    Effect.gen(function*() {
      // `HAPCryptoTest.c` carries a test whose only purpose is to fail if a
      // verifier is stored in OpenSSL's minimal `BN_bn2bin` form instead of
      // padded to `SRP_VERIFIER_BYTES`. About one verifier in 256 has a
      // leading zero octet, so a short-storing implementation works for weeks.
      //
      // A deliberately awkward salt so the exact width is asserted rather than
      // inherited from the vector's own good luck.
      const v = yield* verifier(group, {
        username: "",
        password: "",
        salt: Uint8Array.from({ length: 16 }, (_, index) => index)
      })
      assert.strictEqual(v.length, 384)
    }).pipe(Effect.provide(NodeServices.layer)))
})
