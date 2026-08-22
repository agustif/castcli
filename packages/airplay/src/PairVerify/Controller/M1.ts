// M1 — controller starts pair-verify by sending its ephemeral public key.
//
// The smallest message: State 1, the controller's X25519 public key, and
// nothing else. Returns only bytes because M3 needs the ephemeral private key
// (to compute the shared secret) and the controller's long-term identity (to
// sign), both of which the caller already has.

import { Effect, Schema } from "effect"
import { TlvType } from "../../Generated/index.ts"
import { Items } from "../../Tlv8/index.ts"

const STATE = 1

export const m1 = (controllerPublicKey: Uint8Array): Effect.Effect<Uint8Array> =>
  Effect.gen(function*() {
    return yield* Schema.encodeEffect(Items)([
      { type: TlvType.State, value: new Uint8Array([STATE]) },
      { type: TlvType.PublicKey, value: controllerPublicKey }
    ])
  })
