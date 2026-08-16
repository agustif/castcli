/**
 * The Node implementation of `Suite`, as a layer.
 *
 * @since 0.1.0
 */
import { Crypto, Effect, Layer } from "effect"
import { make } from "../Suite/make.ts"
import { Suite } from "../Suite/Service.ts"
import * as Aead from "./Aead.ts"
import * as Ed25519 from "./Ed25519.ts"
import * as Hkdf from "./Hkdf.ts"
import * as X25519 from "./X25519.ts"

/**
 * `Suite`, backed by `node:crypto`, drawing its randomness from Effect.
 *
 * **Details**
 *
 * Depends on `Crypto.Crypto` rather than calling `crypto.randomBytes` itself,
 * and that dependency is the reason any of this is a service. Key generation is
 * the only non-deterministic thing the suite does; routing it through a context
 * service means a test can provide a `Crypto` whose bytes are fixed and replay
 * an entire pairing exchange, byte for byte, without a device and without a
 * mock of the pairing code itself. A layer that reached for `node:crypto`
 * directly would make that impossible while looking identical from the outside.
 *
 * **When to use**
 *
 * Provide it at the edge of a Node program, over something that supplies
 * `Crypto` — `NodeServices.layer` from `@effect/platform-node` already does,
 * and so does `NodeCrypto.layer` alone.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect"
 * import { NodeCrypto } from "@effect/platform-node"
 * import { layer } from "./layer.ts"
 *
 * const Live = Layer.provide(layer, NodeCrypto.layer)
 * declare const program: Effect.Effect<void, never, never>
 * const runnable = Effect.provide(program, Live)
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Suite, never, Crypto.Crypto> = Layer.effect(
  Suite,
  Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    return make({
      randomBytes: crypto.randomBytes,
      hkdfSha512: Hkdf.hkdfSha512,
      seal: Aead.seal,
      open: Aead.open,
      ed25519PublicKey: Ed25519.ed25519PublicKey,
      ed25519Sign: Ed25519.ed25519Sign,
      ed25519Verify: Ed25519.ed25519Verify,
      x25519PublicKey: X25519.x25519PublicKey,
      x25519SharedSecret: X25519.x25519SharedSecret
    })
  })
)
