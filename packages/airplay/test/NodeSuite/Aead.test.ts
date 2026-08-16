// ChaCha20-Poly1305, against RFC 8439 section 2.8.2.
//
// The published vector gives key, nonce, associated data, plaintext, ciphertext
// and tag, so it checks the cipher, the tag, the order the associated data is
// fed in, and — because this file asserts on the concatenation — that we append
// the tag rather than prepending it. All four are things a self-consistent
// implementation gets wrong invisibly.
//
// One wrinkle: the RFC's nonce is `07 00 00 00 40 41 42 43 44 45 46 47`, whose
// first four bytes are not zero, so it is not a HAP nonce and neither
// `Nonce.label` nor `Nonce.counter` can produce it. That is the point of those
// two being the only constructions in `Suite`, and it is why this file — and
// only this file — reaches past `Nonce/index.ts` to the type itself. A test of
// the primitive against the specification is exactly the case where the HAP
// restriction is not wanted.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Encoding, Layer, Redacted, Result } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { Suite } from "../../src/Suite/index.ts"
import * as Nonce from "../../src/Suite/Nonce/index.ts"
import { TypeId } from "../../src/Suite/Nonce/Nonce.ts"
import { Sizes } from "../../src/Suite/Sizes.ts"
import { layer } from "../../src/NodeSuite/layer.ts"

const TestSuite = Layer.provide(layer, NodeCrypto.layer)

const bytes = (hex: string): Uint8Array =>
  Result.getOrElse(Encoding.decodeHex(hex), () => new Uint8Array())

/** Twelve arbitrary bytes as a nonce — for specification vectors only. */
const anyNonce = (hex: string): Nonce.Nonce => ({ [TypeId]: TypeId, bytes: bytes(hex) })

/** RFC 8439 section 2.8.2. */
const VECTOR = {
  key: "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f",
  nonce: "070000004041424344454647",
  associatedData: "50515253c0c1c2c3c4c5c6c7",
  plaintext:
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  ciphertext:
    "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116",
  tag: "1ae10b594f09e26a7e902ecbd0600691"
} as const

const utf8 = new TextEncoder()

describe("ChaCha20-Poly1305, against RFC 8439 section 2.8.2", () => {
  it.effect("seals to the published ciphertext with the published tag appended", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const sealed = yield* suite.seal({
        key: Redacted.make(bytes(VECTOR.key)),
        nonce: anyNonce(VECTOR.nonce),
        plaintext: utf8.encode(VECTOR.plaintext),
        associatedData: bytes(VECTOR.associatedData)
      })
      // Asserted as one string rather than in two halves: the layout is part of
      // what is being checked, and a version of this test that compared the
      // pieces separately would pass against an implementation that prepended
      // the tag.
      assert.strictEqual(
        Encoding.encodeHex(sealed),
        `${VECTOR.ciphertext}${VECTOR.tag}`
      )
      assert.strictEqual(sealed.length, VECTOR.plaintext.length + Sizes.TAG)
    }).pipe(Effect.provide(TestSuite)))

  it.effect("opens the published ciphertext", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const opened = yield* suite.open({
        key: Redacted.make(bytes(VECTOR.key)),
        nonce: anyNonce(VECTOR.nonce),
        ciphertextAndTag: bytes(`${VECTOR.ciphertext}${VECTOR.tag}`),
        associatedData: bytes(VECTOR.associatedData)
      })
      assert.strictEqual(new TextDecoder().decode(opened), VECTOR.plaintext)
    }).pipe(Effect.provide(TestSuite)))
})

describe("Suite.open", () => {
  const key = Redacted.make(bytes(VECTOR.key))

  /** The published frame, and the pieces needed to vary one input at a time. */
  const sealed = bytes(`${VECTOR.ciphertext}${VECTOR.tag}`)
  const associatedData = bytes(VECTOR.associatedData)

  it.effect("reports a flipped bit as a forged frame, not a broken platform", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const altered = Uint8Array.from(sealed)
      altered.set([(altered[0] ?? 0) ^ 1], 0)
      // The distinction the error type exists for: a caller can tell "drop this
      // connection" from "this host cannot do cryptography".
      const error = yield* Effect.flip(suite.open({
        key,
        nonce: anyNonce(VECTOR.nonce),
        ciphertextAndTag: altered,
        associatedData
      }))
      assert.strictEqual(error._tag, "ForgedFrame")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("rejects a frame whose associated data was changed", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // Nothing of the ciphertext changes here. If the associated data were
      // being ignored — the commonest way to get an AEAD wrong, because the
      // plaintext still comes back — this would succeed.
      const error = yield* Effect.flip(suite.open({
        key,
        nonce: anyNonce(VECTOR.nonce),
        ciphertextAndTag: sealed,
        associatedData: new Uint8Array()
      }))
      assert.strictEqual(error._tag, "ForgedFrame")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("rejects a frame opened under the wrong nonce", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const error = yield* Effect.flip(suite.open({
        key,
        nonce: anyNonce("070000004041424344454648"),
        ciphertextAndTag: sealed,
        associatedData
      }))
      assert.strictEqual(error._tag, "ForgedFrame")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("calls a frame shorter than its tag a bad argument", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // Not a forged frame: nothing was authenticated, because there was nothing
      // there. A caller that treated this as an attacker would be counting
      // truncated reads as attacks.
      const error = yield* Effect.flip(suite.open({
        key,
        nonce: anyNonce(VECTOR.nonce),
        ciphertextAndTag: new Uint8Array(Sizes.TAG - 1),
        associatedData
      }))
      assert.strictEqual(error._tag, "PlatformError")
    }).pipe(Effect.provide(TestSuite)))
})

describe("a HAP-shaped frame", () => {
  it.effect("round-trips under a labelled nonce, tag and all", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // The path pair-setup actually takes: a key from HKDF, a nonce from a
      // message label, no associated data.
      const key = yield* suite.hkdfSha512({
        key: Redacted.make(new Uint8Array([1, 2, 3, 4])),
        salt: "Pair-Setup-Encrypt-Salt",
        info: "Pair-Setup-Encrypt-Info"
      })
      const nonce = yield* Nonce.label("PS-Msg05")
      const plaintext = new Uint8Array([0x01, 0x02, 0x03])
      const sealed = yield* suite.seal({
        key,
        nonce,
        plaintext,
        associatedData: new Uint8Array()
      })
      assert.strictEqual(sealed.length, plaintext.length + Sizes.TAG)

      const opened = yield* suite.open({
        key,
        nonce: yield* Nonce.label("PS-Msg05"),
        ciphertextAndTag: sealed,
        associatedData: new Uint8Array()
      })
      assert.deepStrictEqual(opened, plaintext)

      // The neighbouring message's label. Same key, same bytes, and it must not
      // open — that is the entire reason each message is named.
      const wrong = yield* Effect.flip(suite.open({
        key,
        nonce: yield* Nonce.label("PS-Msg06"),
        ciphertextAndTag: sealed,
        associatedData: new Uint8Array()
      }))
      assert.strictEqual(wrong._tag, "ForgedFrame")
    }).pipe(Effect.provide(TestSuite)))
})
