// Ed25519, against RFC 8032 rather than against ourselves.
//
// The whole risk in this file's subject is the DER wrapping: a key that is
// wrapped consistently but wrongly signs and verifies perfectly in a round-trip
// test and is rejected by every accessory. So nothing here is a round trip. Each
// case takes a private key, a public key, a message and a signature that were
// published together in RFC 8032 section 7.1, and checks that our derivation
// produces that public key and our signing produces those exact bytes.
//
// Ed25519 is deterministic — no per-signature randomness — which is what makes
// comparing signature bytes to a published constant possible at all. For a
// randomised scheme this test could only have checked verification.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Encoding, Layer, Redacted, Result } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { Suite } from "../../src/Suite/index.ts"
import { layer } from "../../src/NodeSuite/layer.ts"

const TestSuite = Layer.provide(layer, NodeCrypto.layer)

/** A published constant. Anything malformed becomes empty and fails loudly. */
const bytes = (hex: string): Uint8Array =>
  Result.getOrElse(Encoding.decodeHex(hex), () => new Uint8Array())

/**
 * RFC 8032 section 7.1, TEST 1, TEST 2 and TEST 3.
 *
 * Three rather than one because the first has an empty message, which is the
 * case an implementation that accidentally pre-hashes can still get right.
 */
const VECTORS = [
  {
    name: "TEST 1 (empty message)",
    privateKey: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    message: "",
    signature:
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
  },
  {
    name: "TEST 2 (one byte)",
    privateKey: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    publicKey: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    message: "72",
    signature:
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
  },
  {
    name: "TEST 3 (two bytes)",
    privateKey: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
    publicKey: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    message: "af82",
    signature:
      "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"
  }
] as const

describe("Ed25519, against RFC 8032 section 7.1", () => {
  VECTORS.forEach((vector) => {
    it.effect(`derives the published public key — ${vector.name}`, () =>
      Effect.gen(function*() {
        const suite = yield* Suite
        const derived = yield* suite.ed25519PublicKey(Redacted.make(bytes(vector.privateKey)))
        // The single assertion that catches a wrong PKCS8 template: a seed
        // spliced into the wrong envelope yields a different point.
        assert.strictEqual(Encoding.encodeHex(derived), vector.publicKey)
      }).pipe(Effect.provide(TestSuite)))

    it.effect(`produces the published signature — ${vector.name}`, () =>
      Effect.gen(function*() {
        const suite = yield* Suite
        const signature = yield* suite.ed25519Sign({
          privateKey: Redacted.make(bytes(vector.privateKey)),
          message: bytes(vector.message)
        })
        assert.strictEqual(Encoding.encodeHex(signature), vector.signature)
      }).pipe(Effect.provide(TestSuite)))

    it.effect(`accepts the published signature — ${vector.name}`, () =>
      Effect.gen(function*() {
        const suite = yield* Suite
        const ok = yield* suite.ed25519Verify({
          publicKey: bytes(vector.publicKey),
          message: bytes(vector.message),
          signature: bytes(vector.signature)
        })
        assert.isTrue(ok)
      }).pipe(Effect.provide(TestSuite)))
  })

  it.effect("rejects a signature by another key", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const [first, second] = VECTORS
      // TEST 3's signature under TEST 1's key: both are valid signatures of
      // valid messages, so this is the case a verifier that ignores the key
      // would pass.
      const ok = yield* suite.ed25519Verify({
        publicKey: bytes(first.publicKey),
        message: bytes(second.message),
        signature: bytes(second.signature)
      })
      assert.isFalse(ok)
    }).pipe(Effect.provide(TestSuite)))

  it.effect("rejects a signature over a different message", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const [, second] = VECTORS
      const ok = yield* suite.ed25519Verify({
        publicKey: bytes(second.publicKey),
        message: bytes("73"),
        signature: bytes(second.signature)
      })
      assert.isFalse(ok)
    }).pipe(Effect.provide(TestSuite)))

  it.effect("says which argument was the wrong length", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const [first] = VECTORS
      // A 63-byte signature is not a signature that can be false; it is a
      // decoding bug upstream, and answering `false` would hide it.
      const error = yield* Effect.flip(suite.ed25519Verify({
        publicKey: bytes(first.publicKey),
        message: new Uint8Array(),
        signature: bytes(first.signature).subarray(1)
      }))
      assert.strictEqual(error._tag, "PlatformError")
      assert.include(error.message, "signature must be 64 bytes, got 63")
    }).pipe(Effect.provide(TestSuite)))
})
