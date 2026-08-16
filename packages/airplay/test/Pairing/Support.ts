// What the three files beside this one share: a random source that does not
// vary, the two identities the exchange is between, and the small handful of
// byte manipulations every one of them needs.
//
// The random source is the reason this file exists rather than each test
// building its own. Pair-setup draws randomness four times — the controller's
// SRP `a`, the accessory's salt and `b`, and whatever ephemeral keys pair-verify
// invents — and every one of them goes through Effect's `Crypto` service rather
// than through `node:crypto`. So one layer fixes all four, and a whole exchange
// replays byte for byte. That is not a convenience: a test of a protocol that
// produces different bytes on each run can assert that both ends agreed, and
// cannot assert *what* they agreed on, which is exactly the assertion that
// catches an implementation agreeing with itself about the wrong thing.
//
// It is a deterministic *stream*, not a constant. A layer whose `randomBytes`
// answered the same value every time would hand the controller and the
// accessory the same SRP private value and, in pair-verify, the same X25519
// scalar — and two peers holding the same private key still reach a shared
// secret, so the exchange would pass while checking nothing about the
// Diffie-Hellman at all. `PairVerify/Ephemeral/KeyPair.ts` says so in its own
// documentation; this is that warning taken seriously. Successive calls here
// return different bytes, and they return the same different bytes on every
// run.

import { Crypto, Effect, Layer, Redacted, Result, Schema } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { type Item, Items } from "../../src/Tlv8/index.ts"
import { layer as nodeSuite } from "../../src/NodeSuite/index.ts"
import type { Suite } from "../../src/Suite/index.ts"

/**
 * A deterministic byte stream: Numerical Recipes' linear congruential
 * generator, high byte first.
 *
 * The high byte rather than the low one because an LCG's low bits have short
 * periods — the bottom bit of this one alternates — and a stream of alternating
 * bits would make a 32-byte "random" scalar that is not remotely uniform. It
 * does not have to be good randomness, but it has to be randomness-shaped: an
 * X25519 scalar of alternating bits is still a valid scalar, and an SRP private
 * value that is small enough to guess would let a test pass that a real
 * exchange could not.
 *
 * `Math.imul` rather than `*` because the state is 32 bits and the multiplier is
 * ten digits: the product exceeds 2^53 and an ordinary multiplication would lose
 * the low bits — the only bits that carry forward — leaving a generator whose
 * output depends on rounding.
 */
const bytesFrom = (seed: number): (size: number) => Uint8Array => {
  let state = seed >>> 0
  return (size: number) =>
    Uint8Array.from({ length: size }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return (state >>> 24) & 0xff
    })
}

/**
 * `Crypto`, with its randomness pinned and its digests real.
 *
 * Only `randomBytes` is replaced. The digest is delegated to `NodeCrypto`
 * because SHA-512 is load-bearing arithmetic here — SRP's `x`, `u`, `K`, both
 * proofs and every HKDF derivation are hashes — and a test that stubbed it would
 * be checking that this file agrees with itself.
 */
export const PinnedCrypto: Layer.Layer<Crypto.Crypto> = Layer.provide(
  Layer.effect(
    Crypto.Crypto,
    Effect.map(Crypto.Crypto, (real) =>
      Crypto.make({
        randomBytes: bytesFrom(0x5eed_1234),
        digest: (algorithm, data) => real.digest(algorithm, data)
      }))
  ),
  NodeCrypto.layer
)

/**
 * Everything an exchange needs: the HAP suite over the pinned randomness, and
 * that same `Crypto` for the SRP layer, which takes it directly.
 *
 * `provideMerge` rather than `merge` of two independently provided layers, so
 * that there is exactly one generator behind both. Two would be worse than
 * non-deterministic: each would start from the same seed, so the controller's
 * SRP private value and the accessory's would be *identical*, and an exchange
 * between two peers that chose the same secret still completes.
 */
export const Pairing: Layer.Layer<Crypto.Crypto | Suite> = Layer.provideMerge(
  nodeSuite,
  PinnedCrypto
)

/**
 * The setup code on the imaginary television's screen, dashes included.
 *
 * The dashes are part of the password. HomeKit hashes the string as displayed,
 * so an accessory whose verifier was built over `"123-45-678"` rejects a
 * controller that typed `"12345678"` — with `kHAPPairingError_Authentication`,
 * which is indistinguishable from a genuinely wrong code. Both sides here read
 * this constant, which means the tests cannot catch that particular
 * disagreement; what they can do is state it, so that the next reader knows
 * where to look.
 */
export const SETUP_CODE = "123-45-678"

/** A setup code that is well-formed and is not the one on the screen. */
export const WRONG_SETUP_CODE = "999-88-777"

/**
 * The controller's pairing identifier: a UUID in its printed form, 36 bytes,
 * which is exactly `sizeof(HAPPairingID)`.
 */
export const CONTROLLER_IDENTIFIER = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d"

/** The accessory's, in the shape the ADK writes: a device ID. */
export const ACCESSORY_PAIRING_ID = "AA:BB:CC:DD:EE:FF"

/**
 * The two long-term Ed25519 seeds, fixed so that a pairing is the same pairing
 * on every run.
 *
 * Distinct constants rather than two draws from {@link PinnedCrypto}, because
 * the identities have to survive across exchanges: pair-verify runs on the keys
 * pair-setup produced, and a `Verify.test.ts` that generated its own would be
 * testing a pairing that pair-setup never made.
 */
export const CONTROLLER_SEED = Redacted.make(
  Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) & 0xff)
)

/** The accessory's, deliberately unlike the controller's. */
export const ACCESSORY_SEED = Redacted.make(
  Uint8Array.from({ length: 32 }, (_, index) => (index * 13 + 91) & 0xff)
)

/** TLV8 in. */
export const encode = Schema.encodeEffect(Items)

/** TLV8 out — fragments rejoined, which is the whole reason to use the codec. */
export const decode = Schema.decodeUnknownEffect(Items)

/** An item from a type byte and its bytes. */
export const item = (type: number, value: Uint8Array): Item => ({ type, value })

/**
 * The value of one item of a decoded message, or nothing.
 *
 * Answers an empty array for an absent item rather than failing, because every
 * caller here is either about to assert on the value or about to hand it to
 * something that will refuse it — and an empty value refused by name is a
 * clearer failure than a lookup that threw.
 */
export const valueOf = (
  items: ReadonlyArray<Item>,
  type: number
): Uint8Array => items.find((entry) => entry.type === type)?.value ?? new Uint8Array()

/**
 * The `_tag` of a failure, or a sentence saying there was not one.
 *
 * Asserting on the tag rather than on `Result.isFailure` is the difference
 * between "it failed" and "it failed *for the reason the protocol says*", which
 * is the only interesting half — every negative test in this directory is about
 * a specific refusal, and a test that accepted any failure would pass against an
 * implementation that fell over for an unrelated reason.
 */
export const tagOf = (
  outcome: Result.Result<unknown, { readonly _tag: string }>
): string => Result.isFailure(outcome) ? outcome.failure._tag : "no failure"

/**
 * The same bytes with one bit of one byte flipped.
 *
 * A single bit, not a byte and not a truncation, because that is the tamper an
 * AEAD exists to catch and the one a length check cannot: the frame is still the
 * right length, still parses as far as anything before the tag is concerned, and
 * differs from what the sender wrote.
 */
export const flip = (bytes: Uint8Array, index: number): Uint8Array => {
  const copy = Uint8Array.from(bytes)
  copy.set([(copy[index] ?? 0) ^ 0x01], index)
  return copy
}
