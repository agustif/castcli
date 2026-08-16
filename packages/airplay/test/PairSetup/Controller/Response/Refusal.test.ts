// Noticing that the accessory said no.
//
// The failure this prevents is not subtle once seen: an error response contains
// a State and an Error item and nothing else, so a reader that goes looking for
// the salt first reports a missing salt, and the reason the accessory gave —
// which is the only useful thing in the message — is never read.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { PairingError, TlvType } from "../../../../src/Generated/index.ts"
import type { Item } from "../../../../src/Tlv8/index.ts"
import { refusal } from "../../../../src/PairSetup/Controller/Response/Refusal.ts"

const item = (type: number, ...value: ReadonlyArray<number>): Item => ({
  type,
  value: Uint8Array.from(value)
})

const tagOf = (outcome: Result.Result<unknown, { readonly _tag: string }>): string =>
  Result.isFailure(outcome) ? outcome.failure._tag : "no failure"

describe("refusal", () => {
  it.effect("passes a message with no error item through", () =>
    Effect.gen(function*() {
      yield* refusal({
        items: [item(TlvType.State, 2), item(TlvType.Salt, 1, 2, 3)],
        step: "M2"
      })
    }))

  it.effect("turns kHAPPairingError_Authentication into the error a user can act on", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(
        refusal({
          items: [item(TlvType.State, 4), item(TlvType.Error, PairingError.Authentication)],
          step: "M4"
        })
      )
      assert.strictEqual(tagOf(outcome), "PairSetupWrongSetupCode")
    }))

  it.effect("turns the other codes into a refusal that carries the byte", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(
        refusal({
          items: [item(TlvType.State, 2), item(TlvType.Error, PairingError.MaxTries)],
          step: "M2"
        })
      )
      assert.strictEqual(tagOf(outcome), "PairSetupAccessoryRefused")
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure.message : "",
        "pair-setup M2: the accessory declined with MaxTries (5)"
      )
    }))

  it.effect("treats an error item of the wrong length as a refusal all the same", () =>
    Effect.gen(function*() {
      // Deliberately laxer than everything else in this module. `Query.byte`
      // would answer `None` for a two-byte item — the right answer for a State
      // byte, and here it would mean carrying on talking to a device that has
      // said no. The reason given is not recoverable, so it is reported as
      // unnamed rather than guessed from the first byte.
      const outcome = yield* Effect.result(
        refusal({ items: [item(TlvType.Error, 2, 0)], step: "M4" })
      )
      assert.strictEqual(tagOf(outcome), "PairSetupWrongSetupCode")
    }))

  it.effect("treats an empty error item as a refusal with no name", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.result(
        refusal({ items: [item(TlvType.Error)], step: "M4" })
      )
      assert.strictEqual(
        Result.isFailure(outcome) ? outcome.failure.message : "",
        "pair-setup M4: the accessory declined with an unnamed value (0)"
      )
    }))
})
