// Stripping the envelope, and refusing to strip the wrong one.
//
// The vector tests in `Ed25519.test.ts` and `X25519.test.ts` already prove this
// returns the right 32 bytes — a wrong answer there would not match a published
// public key. What they cannot show is the negative case, because nothing in a
// vector asks for a key to be exported as the curve it is not. That case matters
// because the cheap implementation of this function is "take the last 32 bytes",
// which cannot fail and would return 32 plausible bytes from any structure at
// all.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Encoding } from "effect"
import * as NodeCrypto from "node:crypto"
import { Ed25519, X25519 } from "../../../src/NodeSuite/Der/Curve.ts"
import { exportPublic } from "../../../src/NodeSuite/Der/exportPublic.ts"

const pair = NodeCrypto.generateKeyPairSync("ed25519")

describe("Der.exportPublic", () => {
  it.effect("returns the 32 bytes that follow the envelope", () =>
    Effect.gen(function*() {
      const raw = yield* exportPublic(Ed25519, pair.publicKey)
      const der = Uint8Array.from(pair.publicKey.export({ format: "der", type: "spki" }))
      assert.strictEqual(raw.length, 32)
      assert.strictEqual(
        Encoding.encodeHex(raw),
        Encoding.encodeHex(der.subarray(Ed25519.spkiPrefix.length))
      )
    }))

  it.effect("refuses to read an Ed25519 key as an X25519 one", () =>
    Effect.gen(function*() {
      // The two envelopes differ by a single byte of object identifier, so this
      // is the check that stands between a curve mix-up and 32 bytes that look
      // exactly like a key.
      const error = yield* Effect.flip(exportPublic(X25519, pair.publicKey))
      assert.strictEqual(error._tag, "PlatformError")
      assert.include(error.message, "not X25519")
    }))
})
