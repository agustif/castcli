// X25519, against RFC 7748 section 6.1.
//
// The published Alice/Bob exchange gives both private keys, both public keys and
// the shared secret, so this checks three separate things that a self-consistent
// but wrongly wrapped implementation would still get wrong:
//
//   - each private key derives the published public key, which pins the PKCS8
//     template and the object identifier;
//   - both sides compute the published shared secret, which pins the scalar
//     multiplication and the SPKI template;
//   - the two sides agree, which is the property the protocol actually needs and
//     the only one a round-trip test would have checked.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Encoding, Layer, Redacted, Result } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { Suite } from "../../src/Suite/index.ts"
import { layer } from "../../src/NodeSuite/layer.ts"

const TestSuite = Layer.provide(layer, NodeCrypto.layer)

const bytes = (hex: string): Uint8Array =>
  Result.getOrElse(Encoding.decodeHex(hex), () => new Uint8Array())

/** RFC 7748 section 6.1. */
const ALICE = {
  privateKey: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  publicKey: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"
} as const

const BOB = {
  privateKey: "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
  publicKey: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f"
} as const

const SHARED = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"

describe("X25519, against RFC 7748 section 6.1", () => {
  it.effect("derives Alice's and Bob's published public keys", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const alice = yield* suite.x25519PublicKey(Redacted.make(bytes(ALICE.privateKey)))
      const bob = yield* suite.x25519PublicKey(Redacted.make(bytes(BOB.privateKey)))
      // Note that neither private key is clamped in the RFC's text — the low
      // bits of Alice's key are set. Clamping happens inside the multiplication,
      // so importing the bytes verbatim is correct and pre-clamping them here
      // would also produce these answers, which is why the check is on the
      // published public key rather than on the key we imported.
      assert.strictEqual(Encoding.encodeHex(alice), ALICE.publicKey)
      assert.strictEqual(Encoding.encodeHex(bob), BOB.publicKey)
    }).pipe(Effect.provide(TestSuite)))

  it.effect("computes the published shared secret from either side", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const fromAlice = yield* suite.x25519SharedSecret({
        privateKey: Redacted.make(bytes(ALICE.privateKey)),
        publicKey: bytes(BOB.publicKey)
      })
      const fromBob = yield* suite.x25519SharedSecret({
        privateKey: Redacted.make(bytes(BOB.privateKey)),
        publicKey: bytes(ALICE.publicKey)
      })
      assert.strictEqual(Encoding.encodeHex(Redacted.value(fromAlice)), SHARED)
      assert.strictEqual(Encoding.encodeHex(Redacted.value(fromBob)), SHARED)
    }).pipe(Effect.provide(TestSuite)))

  it.effect("refuses a peer key of small order rather than agreeing on zero", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // The all-zero point drives the shared secret to zero whatever our scalar
      // is. An implementation that returned those zeros would let a peer fix the
      // session key on its own, and both ends would agree on it perfectly.
      const error = yield* Effect.flip(suite.x25519SharedSecret({
        privateKey: Redacted.make(bytes(ALICE.privateKey)),
        publicKey: new Uint8Array(32)
      }))
      assert.strictEqual(error._tag, "PlatformError")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("a fresh pair agrees with a published one", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // Closes the loop between the generated key path and the vector path: the
      // ephemeral pairs pair-verify actually uses are made by `x25519KeyPair`,
      // and nothing above exercises it.
      const ours = yield* suite.x25519KeyPair
      const toBob = yield* suite.x25519SharedSecret({
        privateKey: ours.privateKey,
        publicKey: bytes(BOB.publicKey)
      })
      const fromBob = yield* suite.x25519SharedSecret({
        privateKey: Redacted.make(bytes(BOB.privateKey)),
        publicKey: ours.publicKey
      })
      assert.deepStrictEqual(Redacted.value(toBob), Redacted.value(fromBob))
    }).pipe(Effect.provide(TestSuite)))
})
