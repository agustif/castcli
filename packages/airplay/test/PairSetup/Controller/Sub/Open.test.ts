// Opening the sub-TLV, and the three ways it can refuse to.
//
// The tag is the only thing standing between the caller and a payload of noise:
// ChaCha20 is a stream cipher, so decrypting with the wrong key succeeds in the
// sense of producing bytes, and those bytes will occasionally parse as a TLV8
// item or two. Every assertion here is about failing rather than proceeding.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Result } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { TlvType } from "../../../../src/Generated/index.ts"
import { Nonce, Suite } from "../../../../src/Suite/index.ts"
import { layer } from "../../../../src/NodeSuite/index.ts"
import { open } from "../../../../src/PairSetup/Controller/Sub/Open.ts"
import { seal } from "../../../../src/PairSetup/Controller/Sub/Seal.ts"

const TestSuite = Layer.provide(layer, NodeCrypto.layer)

const KEY = Redacted.make(Uint8Array.from({ length: 32 }, (_, index) => index))
const OTHER = Redacted.make(new Uint8Array(32))

const items = [
  { type: TlvType.Identifier, value: new TextEncoder().encode("accessory") },
  { type: TlvType.PublicKey, value: new Uint8Array(32) }
]

const tagOf = (outcome: Result.Result<unknown, { readonly _tag: string }>): string =>
  Result.isFailure(outcome) ? outcome.failure._tag : "no failure"

describe("open", () => {
  it.effect("is the inverse of seal", () =>
    Effect.gen(function*() {
      const nonce = yield* Nonce.label("PS-Msg06")
      const sealed = yield* seal({ key: KEY, nonce, items })
      const opened = yield* open({ key: KEY, nonce, sealed })
      assert.deepStrictEqual(opened, items)
    }).pipe(Effect.provide(TestSuite)))

  it.effect("refuses a frame whose ciphertext was altered", () =>
    Effect.gen(function*() {
      // A single flipped bit. Without the tag this would decrypt to a payload
      // differing from the accessory's in exactly one byte — an identifier, or
      // a byte of a public key — and everything downstream would carry on.
      const nonce = yield* Nonce.label("PS-Msg06")
      const sealed = yield* seal({ key: KEY, nonce, items })
      const tampered = Uint8Array.from(sealed)
      tampered[0] = (tampered[0] ?? 0) ^ 0x01

      const outcome = yield* Effect.result(open({ key: KEY, nonce, sealed: tampered }))
      assert.strictEqual(tagOf(outcome), "ForgedFrame")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("refuses a frame whose tag was altered", () =>
    Effect.gen(function*() {
      const nonce = yield* Nonce.label("PS-Msg06")
      const sealed = yield* seal({ key: KEY, nonce, items })
      const tampered = Uint8Array.from(sealed)
      tampered[sealed.length - 1] = (tampered[sealed.length - 1] ?? 0) ^ 0x01

      const outcome = yield* Effect.result(open({ key: KEY, nonce, sealed: tampered }))
      assert.strictEqual(tagOf(outcome), "ForgedFrame")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("refuses the right frame under the wrong nonce", () =>
    Effect.gen(function*() {
      // The two directions of the exchange share a key and differ only in the
      // nonce, so this is what a controller that opened M6 with `PS-Msg05` would
      // see: a genuine message from a genuine accessory, rejected.
      const sealed = yield* seal({
        key: KEY,
        nonce: yield* Nonce.label("PS-Msg06"),
        items
      })
      const outcome = yield* Effect.result(
        open({ key: KEY, nonce: yield* Nonce.label("PS-Msg05"), sealed })
      )
      assert.strictEqual(tagOf(outcome), "ForgedFrame")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("refuses the right frame under the wrong key", () =>
    Effect.gen(function*() {
      const nonce = yield* Nonce.label("PS-Msg06")
      const sealed = yield* seal({ key: KEY, nonce, items })
      const outcome = yield* Effect.result(open({ key: OTHER, nonce, sealed }))
      assert.strictEqual(tagOf(outcome), "ForgedFrame")
    }).pipe(Effect.provide(TestSuite)))

  it.effect("distinguishes a bad tag from a plaintext that is not a payload", () =>
    Effect.gen(function*() {
      // Both are failures and they mean opposite things: a `ForgedFrame` is the
      // peer or the wire, and a `SchemaError` here is the peer sealing
      // something other than an encoded payload — which cannot happen between
      // two correct implementations.
      const nonce = yield* Nonce.label("PS-Msg06")
      const suite = yield* Suite
      const sealed = yield* suite.seal({
        key: KEY,
        nonce,
        // A type byte promising four bytes of value with none after it.
        plaintext: Uint8Array.of(TlvType.Identifier, 4),
        associatedData: new Uint8Array()
      })
      const outcome = yield* Effect.result(open({ key: KEY, nonce, sealed }))
      assert.strictEqual(tagOf(outcome), "SchemaError")
    }).pipe(Effect.provide(TestSuite)))
})
