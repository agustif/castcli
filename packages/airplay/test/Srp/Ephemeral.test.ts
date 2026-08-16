// Where a and b come from, and why that is a service rather than a call to
// node:crypto.
//
// The claim this file exists to demonstrate: because randomness arrives
// through `Crypto`, a layer can supply fixed bytes and an exchange that is
// otherwise different on every run becomes a reproducible sequence of numbers.
// Without that, none of the vector tests in this directory could exist —
// Apple's `b` could never be put into the code that uses it.

import { assert, describe, it } from "@effect/vitest"
import { Crypto, Effect, Layer, Option } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SrpVectors } from "../../src/Generated/index.ts"
import { BYTES, ephemeral } from "../../src/Srp/Ephemeral.ts"
import { toBigInt } from "../../src/Srp/Math/index.ts"

/**
 * A `Crypto` whose randomness is a counter.
 *
 * Nothing here hashes, so `digest` is never reached; it returns its input so
 * the layer stays honest about doing no cryptography rather than pretending
 * to.
 */
const Counted = Layer.succeed(Crypto.Crypto)(
  Crypto.make({
    randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 1),
    digest: (_algorithm, data) => Effect.succeed(data)
  })
)

describe("BYTES", () => {
  it("is the width of the private value in HAPCrypto.h", () => {
    assert.strictEqual(BYTES, 32)
    assert.strictEqual(SrpVectors.b.length, BYTES)
  })
})

describe("ephemeral", () => {
  it.effect("uses a supplied value byte for byte", () =>
    Effect.gen(function*() {
      // Exactly what the vector tests need: Apple's `b`, unmodified, not
      // reduced, not padded.
      const b = yield* ephemeral(Option.some(SrpVectors.b))
      assert.strictEqual(b, toBigInt(SrpVectors.b))
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("asks the Crypto service when nothing is supplied", () =>
    Effect.gen(function*() {
      // The payoff, stated as an assertion: under a pinned layer the "random"
      // private value is a known number. Under NodeServices it would not be,
      // and no test could name it.
      const a = yield* ephemeral(Option.none())
      assert.strictEqual(
        a,
        toBigInt(Uint8Array.from({ length: BYTES }, (_, index) => index + 1))
      )
    }).pipe(Effect.provide(Counted)))

  it.effect("takes 32 octets, not some other width", () =>
    Effect.gen(function*() {
      // A private value shorter than the specification's minimum would still
      // produce a working exchange with a cooperating peer, which is why the
      // width is asserted rather than assumed.
      const a = yield* ephemeral(Option.none())
      assert.isTrue(a < 2n ** BigInt(BYTES * 8), "wider than 32 octets")
      assert.isTrue(a >= 2n ** BigInt((BYTES - 1) * 8), "narrower than 32 octets")
    }).pipe(Effect.provide(Counted)))
})
