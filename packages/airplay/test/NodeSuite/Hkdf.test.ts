// HKDF-SHA512, checked against the formula rather than against a vector.
//
// RFC 5869 publishes test vectors for SHA-256 and SHA-1 only, and there is no
// SHA-512 case anywhere in it. So this recomputes the derivation here from raw
// HMAC-SHA512 — extract, then one round of expand — and checks the two agree.
//
// Be clear about how weak that is. Both sides of the comparison were written by
// the same author from the same reading of the same document, so a
// misunderstanding of RFC 5869 would be reproduced identically on both sides and
// this test would pass. It rules out a wiring mistake — arguments swapped, the
// wrong digest selected, an output truncated from the wrong end — and it rules
// out nothing about whether the formula is the right formula.
//
// What would make it strong is a vector produced by an implementation nobody
// here wrote: the SHA-512 HKDF outputs published by another project, or the
// vendored `HAP_hkdf_sha512` compiled and run. Until one of those is in the
// repository, the real check on this function is that a pairing exchange against
// the emulated accessory — built from the same specification but by different
// code — reaches a shared session key.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import * as Node from "node:crypto"
import { Sizes, Suite } from "../../src/Suite/index.ts"
import { layer } from "../../src/NodeSuite/layer.ts"

const TestSuite = Layer.provide(layer, NodeCrypto.layer)

const utf8 = new TextEncoder()

/**
 * RFC 5869 section 2, written out: PRK = HMAC(salt, IKM), then
 * OKM = HMAC(PRK, info ‖ 0x01) truncated to the length wanted.
 *
 * The single 0x01 block is enough because SHA-512 produces 64 bytes and 32 are
 * wanted; a longer output would need T(2) = HMAC(PRK, T(1) ‖ info ‖ 0x02) and so
 * on, which is exactly the loop this derivation is fixed at 32 bytes to avoid.
 */
const byHand = (ikm: Uint8Array, salt: string, info: string): Uint8Array => {
  const prk = Node.createHmac("sha512", utf8.encode(salt)).update(ikm).digest()
  const t1 = Node.createHmac("sha512", prk)
    .update(Uint8Array.from([...utf8.encode(info), 1]))
    .digest()
  return Uint8Array.from(t1.subarray(0, Sizes.KEY))
}

const IKM = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77])

describe("HKDF-SHA512", () => {
  it.effect("agrees with extract-then-expand computed from raw HMAC-SHA512", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // HAP's own constants, so the arguments are in the order and the shape the
      // protocol will use them.
      const derived = yield* suite.hkdfSha512({
        key: Redacted.make(IKM),
        salt: "Pair-Setup-Encrypt-Salt",
        info: "Pair-Setup-Encrypt-Info"
      })
      assert.deepStrictEqual(
        Redacted.value(derived),
        byHand(IKM, "Pair-Setup-Encrypt-Salt", "Pair-Setup-Encrypt-Info")
      )
    }).pipe(Effect.provide(TestSuite)))

  it.effect("produces exactly one AEAD key", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      const derived = yield* suite.hkdfSha512({
        key: Redacted.make(IKM),
        salt: "salt",
        info: "info"
      })
      assert.strictEqual(Redacted.value(derived).length, Sizes.KEY)
    }).pipe(Effect.provide(TestSuite)))

  it.effect("separates keys by salt and by info", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // The property HAP relies on to get a write key and a read key out of one
      // shared secret. An implementation that ignored `info` — easy to do, since
      // it is the argument RFC 5869 makes optional — would derive one key for
      // both directions, and the session would still work perfectly against
      // itself while being trivially replayable.
      const base = yield* suite.hkdfSha512({
        key: Redacted.make(IKM),
        salt: "Control-Salt",
        info: "Control-Write-Encryption-Key"
      })
      const otherInfo = yield* suite.hkdfSha512({
        key: Redacted.make(IKM),
        salt: "Control-Salt",
        info: "Control-Read-Encryption-Key"
      })
      const otherSalt = yield* suite.hkdfSha512({
        key: Redacted.make(IKM),
        salt: "Other-Salt",
        info: "Control-Write-Encryption-Key"
      })
      assert.notStrictEqual(
        Encoding.encodeHex(Redacted.value(base)),
        Encoding.encodeHex(Redacted.value(otherInfo))
      )
      assert.notStrictEqual(
        Encoding.encodeHex(Redacted.value(base)),
        Encoding.encodeHex(Redacted.value(otherSalt))
      )
    }).pipe(Effect.provide(TestSuite)))

  it.effect("takes the salt as text, not as hexadecimal", () =>
    Effect.gen(function*() {
      const suite = yield* Suite
      // `"4d4649"` is the hexadecimal of `"MFI"`. If the salt were being decoded
      // rather than encoded, these two would agree — and the bug would only
      // surface against a real accessory, as a session key nobody shares.
      const asText = yield* suite.hkdfSha512({
        key: Redacted.make(IKM),
        salt: "4d4649",
        info: "info"
      })
      const asBytes = yield* suite.hkdfSha512({
        key: Redacted.make(IKM),
        salt: "MFI",
        info: "info"
      })
      assert.notStrictEqual(
        Encoding.encodeHex(Redacted.value(asText)),
        Encoding.encodeHex(Redacted.value(asBytes))
      )
    }).pipe(Effect.provide(TestSuite)))
})
