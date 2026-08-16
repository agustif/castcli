// The message inside the message, sealed.
//
// What is asserted is the shape of the frame — a TLV8 payload as the plaintext,
// the tag appended, nothing authenticated but the payload itself — because
// those are the three decisions an accessory disagrees with silently. Getting
// any of them wrong produces a frame of a plausible length that fails to
// authenticate at the far end with the same error as a wrong setup code.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { TlvType } from "../../../../src/Generated/index.ts"
import { Items } from "../../../../src/Tlv8/index.ts"
import { Nonce, Sizes, Suite } from "../../../../src/Suite/index.ts"
import { layer } from "../../../../src/NodeSuite/index.ts"
import { seal } from "../../../../src/PairSetup/Controller/Sub/Seal.ts"

const TestSuite = Layer.provide(layer, NodeCrypto.layer)

const KEY = Redacted.make(Uint8Array.from({ length: 32 }, (_, index) => index))

const items = [
  { type: TlvType.Identifier, value: new TextEncoder().encode("controller") },
  { type: TlvType.PublicKey, value: new Uint8Array(32) },
  { type: TlvType.Signature, value: new Uint8Array(64) }
]

describe("seal", () => {
  it.effect("seals the encoded payload, with the tag appended", () =>
    Effect.gen(function*() {
      const nonce = yield* Nonce.label("PS-Msg05")
      const sealed = yield* seal({ key: KEY, nonce, items })
      const plaintext = yield* Schema.encodeEffect(Items)(items)

      // The length is the assertion: ciphertext is the same size as plaintext
      // under a stream cipher, so anything else here means the tag is somewhere
      // other than the end, or the plaintext was not the encoded payload.
      assert.strictEqual(sealed.length, plaintext.length + Sizes.TAG)
    }).pipe(Effect.provide(TestSuite)))

  it.effect("seals a payload an accessory could parse, not three values glued together", () =>
    Effect.gen(function*() {
      // The mistake this catches is the common one: encrypting identifier ||
      // key || signature rather than a TLV8 payload containing them. Both are
      // the same kind of thing to look at and only one can be read by
      // `HAPPairingPairSetupProcessM5`.
      const nonce = yield* Nonce.label("PS-Msg05")
      const sealed = yield* seal({ key: KEY, nonce, items })
      const suite = yield* Suite
      const plaintext = yield* suite.open({
        key: KEY,
        nonce,
        ciphertextAndTag: sealed,
        associatedData: new Uint8Array()
      })
      const parsed = yield* Schema.decodeUnknownEffect(Items)(plaintext)
      assert.deepStrictEqual(parsed.map((item) => item.type), [
        TlvType.Identifier,
        TlvType.PublicKey,
        TlvType.Signature
      ])
    }).pipe(Effect.provide(TestSuite)))

  it.effect("authenticates nothing but the payload", () =>
    Effect.gen(function*() {
      // Pairing messages have no associated data — the control channel that
      // follows pairing is what authenticates a length prefix that way — so a
      // frame sealed here must open with none. If this file passed anything,
      // the accessory's open would fail and read as a bad setup code.
      const nonce = yield* Nonce.label("PS-Msg05")
      const sealed = yield* seal({ key: KEY, nonce, items })
      const suite = yield* Suite
      yield* suite.open({
        key: KEY,
        nonce,
        ciphertextAndTag: sealed,
        associatedData: new Uint8Array()
      })
    }).pipe(Effect.provide(TestSuite)))
})
