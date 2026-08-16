/**
 * Building a `Suite` from the pieces that genuinely cannot be derived.
 *
 * `Crypto.make` takes two primitives — random bytes and a digest — and derives
 * UUIDs, shuffling and every random helper from them, so a new platform has two
 * things to get right rather than a dozen. This does the same with the four HAP
 * needs, and the discipline pays off twice here:
 *
 *   - key generation is *not* primitive. An Ed25519 seed and an X25519 scalar
 *     are both 32 uniformly random bytes, so both key pairs fall out of random
 *     bytes plus the public-key derivation an implementation has to provide
 *     anyway. Handing that to the platform instead would mean a test could never
 *     fix a key pair, and a pairing exchange could never be reproduced.
 *   - length checking is not primitive either, and belongs here rather than in
 *     each implementation. A 31-byte key reaching Node surfaces as
 *     `ERR_CRYPTO_INVALID_KEYLEN` from inside OpenSSL; caught here it names the
 *     argument, the operation and both lengths.
 *
 * @since 0.1.0
 */
import { Effect, Option, PlatformError, Redacted } from "effect"
import type { KeyPair } from "./KeyPair.ts"
import { Suite, SuiteTypeId } from "./Service.ts"
import { Sizes } from "./Sizes.ts"

/**
 * What an implementation of the suite has to supply.
 *
 * **Details**
 *
 * The four HAP primitives, plus the random bytes the key-pair derivations are
 * built on. Random bytes are a parameter rather than a fifth primitive because
 * Effect already has them: `NodeSuite.layer` takes `Crypto.Crypto` from context
 * and passes `crypto.randomBytes` straight in, and a test layer passes a
 * counter. Nothing in this package calls a platform random generator directly.
 *
 * **Gotchas**
 *
 * `randomBytes` must be cryptographically secure in production. It is the only
 * source of long-term identity keys and of every ephemeral pair-verify key, so a
 * predictable one makes the whole exchange forgeable — and it will still pass
 * every test in this repository, because the tests deliberately fix it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Primitives {
  readonly randomBytes: (size: number) => Effect.Effect<Uint8Array, PlatformError.PlatformError>
  readonly hkdfSha512: Suite["hkdfSha512"]
  readonly seal: Suite["seal"]
  readonly open: Suite["open"]
  readonly ed25519PublicKey: Suite["ed25519PublicKey"]
  readonly ed25519Sign: Suite["ed25519Sign"]
  readonly ed25519Verify: Suite["ed25519Verify"]
  readonly x25519PublicKey: Suite["x25519PublicKey"]
  readonly x25519SharedSecret: Suite["x25519SharedSecret"]
}

/** An argument, the bytes given for it, and how many there should have been. */
type Expectation = readonly [what: string, bytes: Uint8Array, expected: number]

const badArgument = (method: string, description: string) =>
  Effect.fail(
    PlatformError.badArgument({ module: "Suite", method, description })
  )

/**
 * Every argument is the length it claims to be.
 *
 * Reports the first that is not, rather than collecting them: the second
 * complaint is almost always a consequence of the first — a caller that swapped
 * two arguments gets both wrong — and one accurate sentence is easier to act on
 * than two.
 */
const exactly = (
  method: string,
  expectations: ReadonlyArray<Expectation>
): Effect.Effect<void, PlatformError.PlatformError> =>
  Option.match(
    Option.fromNullishOr(expectations.find(([, bytes, expected]) => bytes.length !== expected)),
    {
      onNone: () => Effect.void,
      onSome: ([what, bytes, expected]) =>
        badArgument(method, `${what} must be ${expected} bytes, got ${bytes.length}`)
    }
  )

/** Sealed frames vary in length, but never fall below one tag. */
const atLeastATag = (
  method: string,
  sealed: Uint8Array
): Effect.Effect<void, PlatformError.PlatformError> =>
  sealed.length >= Sizes.TAG
    ? Effect.void
    : badArgument(
      method,
      `a sealed frame is at least the ${Sizes.TAG}-byte tag, got ${sealed.length}`
    )

/**
 * Assemble a `Suite`, checking argument lengths and deriving key generation.
 *
 * **When to use**
 *
 * From a runtime's layer module — `NodeSuite/layer.ts` is the only caller in
 * this package — or from a test that wants a suite with fixed randomness.
 *
 * **Details**
 *
 * The returned service calls straight through to `primitives` once the lengths
 * are right, so an implementation is free to assume them. That assumption is
 * load-bearing: `NodeSuite/Ed25519.ts` splices raw keys into DER templates whose
 * length bytes are constants, and a 31-byte key spliced into a template that
 * claims 32 produces a structure OpenSSL either rejects or, worse, reads past.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { make } from "./make.ts"
 *
 * declare const primitives: Parameters<typeof make>[0]
 * const suite = make(primitives)
 * const identity = Effect.map(suite.ed25519KeyPair, (pair) => pair.publicKey)
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (primitives: Primitives): Suite => {
  const ed25519PublicKey: Suite["ed25519PublicKey"] = (privateKey) =>
    Effect.flatMap(
      exactly("ed25519PublicKey", [
        ["an Ed25519 seed", Redacted.value(privateKey), Sizes.PRIVATE_KEY]
      ]),
      () => primitives.ed25519PublicKey(privateKey)
    )

  const x25519PublicKey: Suite["x25519PublicKey"] = (privateKey) =>
    Effect.flatMap(
      exactly("x25519PublicKey", [
        ["an X25519 scalar", Redacted.value(privateKey), Sizes.PRIVATE_KEY]
      ]),
      () => primitives.x25519PublicKey(privateKey)
    )

  /**
   * A pair from 32 random bytes and the public-key derivation.
   *
   * The checked derivations above are used rather than the raw primitives, so a
   * layer whose `randomBytes` returns the wrong length says so here instead of
   * producing a key pair that is subtly short.
   */
  const keyPair = (
    publicKeyOf: (
      privateKey: Redacted.Redacted<Uint8Array>
    ) => Effect.Effect<Uint8Array, PlatformError.PlatformError>
  ): Effect.Effect<KeyPair, PlatformError.PlatformError> =>
    Effect.gen(function*() {
      const privateKey = Redacted.make(yield* primitives.randomBytes(Sizes.PRIVATE_KEY))
      return { publicKey: yield* publicKeyOf(privateKey), privateKey }
    })

  return Suite.of({
    [SuiteTypeId]: SuiteTypeId,

    // Unchecked, alone among these. The input keying material is whatever the
    // exchange produced — an SRP premaster secret is 384 bytes, an X25519 one is
    // 32 — and HKDF's extract step exists precisely to absorb an input of any
    // length and any distribution. There is no length here that would be wrong.
    hkdfSha512: primitives.hkdfSha512,

    seal: (options) =>
      Effect.flatMap(
        exactly("seal", [["a session key", Redacted.value(options.key), Sizes.KEY]]),
        () => primitives.seal(options)
      ),

    open: (options) =>
      Effect.flatMap(
        Effect.flatMap(
          exactly("open", [["a session key", Redacted.value(options.key), Sizes.KEY]]),
          () => atLeastATag("open", options.ciphertextAndTag)
        ),
        () => primitives.open(options)
      ),

    ed25519PublicKey,

    ed25519Sign: (options) =>
      Effect.flatMap(
        exactly("ed25519Sign", [
          ["an Ed25519 seed", Redacted.value(options.privateKey), Sizes.PRIVATE_KEY]
        ]),
        () => primitives.ed25519Sign(options)
      ),

    ed25519Verify: (options) =>
      Effect.flatMap(
        exactly("ed25519Verify", [
          ["an Ed25519 public key", options.publicKey, Sizes.PUBLIC_KEY],
          ["an Ed25519 signature", options.signature, Sizes.SIGNATURE]
        ]),
        () => primitives.ed25519Verify(options)
      ),

    x25519PublicKey,

    x25519SharedSecret: (options) =>
      Effect.flatMap(
        exactly("x25519SharedSecret", [
          ["an X25519 scalar", Redacted.value(options.privateKey), Sizes.PRIVATE_KEY],
          ["an X25519 public key", options.publicKey, Sizes.PUBLIC_KEY]
        ]),
        () => primitives.x25519SharedSecret(options)
      ),

    ed25519KeyPair: keyPair(ed25519PublicKey),
    x25519KeyPair: keyPair(x25519PublicKey)
  })
}
