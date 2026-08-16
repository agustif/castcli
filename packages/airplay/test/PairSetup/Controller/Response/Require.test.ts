// Required items, and the width checks that keep a truncated message from
// being reported as a peer that failed to authenticate.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { TlvType } from "../../../../src/Generated/index.ts"
import type { Item } from "../../../../src/Tlv8/index.ts"
import {
  atMost,
  exactly,
  required
} from "../../../../src/PairSetup/Controller/Response/Require.ts"

const item = (type: number, length: number): Item => ({
  type,
  value: new Uint8Array(length)
})

const where = { step: "M6", within: "sub-TLV" } as const

describe("required", () => {
  it.effect("returns the value of the item it was asked for", () =>
    Effect.gen(function*() {
      const value = yield* required({
        ...where,
        items: [item(TlvType.Identifier, 4), item(TlvType.PublicKey, 32)],
        type: TlvType.PublicKey
      })
      assert.strictEqual(value.length, 32)
    }))

  it.effect("fails with an error naming the item, not with an empty array", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(
        required({ ...where, items: [], type: TlvType.Signature })
      )
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure.message : "",
        "pair-setup M6: the sub-TLV has no Signature item"
      )
    }))

  it.effect("treats a present but empty item as present", () =>
    Effect.gen(function*() {
      // Absent and empty are different in TLV8 — `kTLVType_Separator` carries
      // all of its meaning by being an empty item — so this must not fold them
      // together. The length check is `exactly`'s business.
      const value = yield* required({
        ...where,
        items: [item(TlvType.Identifier, 0)],
        type: TlvType.Identifier
      })
      assert.strictEqual(value.length, 0)
    }))
})

describe("exactly", () => {
  it.effect("passes a value of the right width through", () =>
    Effect.gen(function*() {
      const value = yield* exactly({
        ...where,
        items: [item(TlvType.Signature, 64)],
        type: TlvType.Signature,
        bytes: 64
      })
      assert.strictEqual(value.length, 64)
    }))

  it.effect("rejects a short signature here rather than at the verifier", () =>
    Effect.gen(function*() {
      // The case that matters. A 63-byte signature reaching `ed25519Verify`
      // fails as a bad argument, and an implementation that instead answered
      // `false` for it would report a truncated message as an impostor.
      const outcome = yield* Effect.result(
        exactly({
          ...where,
          items: [item(TlvType.Signature, 63)],
          type: TlvType.Signature,
          bytes: 64
        })
      )
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure.message : "",
        "pair-setup M6: the sub-TLV's Signature item is 63 bytes; expected exactly 64"
      )
    }))

  it.effect("rejects a long one too", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(
        exactly({
          ...where,
          items: [item(TlvType.PublicKey, 33)],
          type: TlvType.PublicKey,
          bytes: 32
        })
      )
      assert.isTrue(Result.isFailure(outcome), "a 33-byte public key was accepted")
    }))
})

describe("atMost", () => {
  it.effect("accepts anything up to the limit, including the limit", () =>
    Effect.gen(function*() {
      const value = yield* atMost({
        ...where,
        items: [item(TlvType.Identifier, 36)],
        type: TlvType.Identifier,
        bytes: 36
      })
      assert.strictEqual(value.length, 36)
    }))

  it.effect("rejects an identifier no accessory could store", () =>
    Effect.gen(function*() {
      // `HAPPairingID` is 36 bytes. A longer identifier is one this controller
      // could hold and the peer could not, which makes the two records disagree
      // about who the pairing is with.
      const outcome = yield* Effect.result(
        atMost({
          ...where,
          items: [item(TlvType.Identifier, 37)],
          type: TlvType.Identifier,
          bytes: 36
        })
      )
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure.message : "",
        "pair-setup M6: the sub-TLV's Identifier item is 37 bytes; expected at most 36"
      )
    }))
})
