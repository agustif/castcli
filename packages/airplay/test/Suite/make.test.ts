// What `make` adds on top of an implementation: reproducible key generation,
// and argument lengths that fail by name.
//
// The first is the reason any of this is a service. Key generation is the only
// non-deterministic thing the suite does, and because it is derived from
// `Crypto.randomBytes` rather than from a platform key generator, a layer that
// fixes the random bytes fixes the identity — which is what will make a whole
// pairing exchange replayable without a device.
//
// This test fixes them to RFC 8032's first private key, so the generated pair is
// checked against a published public key rather than against itself.

import { assert, describe, it } from "@effect/vitest"
import { Crypto, Effect, Encoding, Layer, Redacted, Result } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { Nonce, Suite } from "../../src/Suite/index.ts"
import { layer } from "../../src/NodeSuite/layer.ts"

const bytes = (hex: string): Uint8Array =>
  Result.getOrElse(Encoding.decodeHex(hex), () => new Uint8Array())

/** RFC 8032 section 7.1, TEST 1: a private key and the public key it gives. */
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
const PUBLIC_KEY = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"

/**
 * A `Crypto` whose randomness is a constant.
 *
 * Deliberately not a partial stand-in for the real service: `Crypto.make`
 * derives UUIDs and every random helper from `randomBytes`, so supplying that
 * one function gives a whole, working service that happens to be predictable.
 */
const FixedRandomness = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => bytes(SEED).slice(0, size),
    digest: (_algorithm, data) => Effect.succeed(data)
  })
)

const Reproducible = Layer.provide(layer, FixedRandomness)
const Live = Layer.provide(layer, NodeCrypto.layer)

describe("Suite.make, key generation", () => {
  it.effect("derives an identity from the random bytes it is given", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const pair = yield* suite.ed25519KeyPair
      // The seed is the random bytes verbatim — no expansion, no hashing —
      // which is what makes an identity storable as 32 bytes and reconstructible
      // from them.
      assert.strictEqual(Encoding.encodeHex(Redacted.value(pair.privateKey)), SEED)
      // And the public half is RFC 8032's, so this checks the derivation and not
      // merely that the two agree with each other.
      assert.strictEqual(Encoding.encodeHex(pair.publicKey), PUBLIC_KEY)
    }).pipe(Effect.provide(Reproducible)))

  it.effect("is reproducible under a fixed randomness layer", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const first = yield* suite.ed25519KeyPair
      const second = yield* suite.ed25519KeyPair
      assert.deepStrictEqual(first.publicKey, second.publicKey)
    }).pipe(Effect.provide(Reproducible)))

  it.effect("is not reproducible under real randomness", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // The other half of the previous test, and the one that would catch a
      // layer that had accidentally been left wired to a constant.
      const first = yield* suite.x25519KeyPair
      const second = yield* suite.x25519KeyPair
      assert.notDeepEqual(first.publicKey, second.publicKey)
    }).pipe(Effect.provide(Live)))

  it.effect("keeps the two algorithms' generated keys apart", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // Same 32 random bytes, two curves, two different public keys. If these
      // ever agreed, one of the DER templates would be naming the other's
      // algorithm.
      const signing = yield* suite.ed25519KeyPair
      const agreement = yield* suite.x25519KeyPair
      assert.deepStrictEqual(
        Redacted.value(signing.privateKey),
        Redacted.value(agreement.privateKey)
      )
      assert.notDeepEqual(signing.publicKey, agreement.publicKey)
    }).pipe(Effect.provide(Reproducible)))
})

describe("Suite.make, argument lengths", () => {
  it.effect("names the argument, the operation and both lengths", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // Unchecked, this reaches OpenSSL and comes back as
      // `ERR_CRYPTO_INVALID_KEYLEN` with nothing to say which of the several
      // 32-byte values in scope was short.
      const error = yield* Effect.flip(suite.seal({
        key: Redacted.make(new Uint8Array(31)),
        nonce: yield* Nonce.label("PS-Msg05"),
        plaintext: new Uint8Array(),
        associatedData: new Uint8Array()
      }))
      assert.strictEqual(error._tag, "PlatformError")
      assert.strictEqual(error.message, "Suite.seal: a session key must be 32 bytes, got 31")
    }).pipe(Effect.provide(Live)))

  it.effect("checks a private key before it is spliced into a DER template", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // The reason this check exists rather than being left to Node: the
      // templates carry constant length bytes, so a 16-byte seed would be
      // spliced into a structure that claims 32 and the failure would be a
      // parse error from inside OpenSSL.
      const error = yield* Effect.flip(
        suite.ed25519PublicKey(Redacted.make(new Uint8Array(16)))
      )
      assert.strictEqual(
        error.message,
        "Suite.ed25519PublicKey: an Ed25519 seed must be 32 bytes, got 16"
      )
    }).pipe(Effect.provide(Live)))

  it.effect("reports only the first wrong argument", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // Both are wrong here. One accurate sentence is easier to act on than two,
      // and the second complaint is usually a consequence of the first.
      const error = yield* Effect.flip(suite.x25519SharedSecret({
        privateKey: Redacted.make(new Uint8Array(4)),
        publicKey: new Uint8Array(4)
      }))
      assert.strictEqual(
        error.message,
        "Suite.x25519SharedSecret: an X25519 scalar must be 32 bytes, got 4"
      )
    }).pipe(Effect.provide(Live)))
})
