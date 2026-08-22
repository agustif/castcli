// Finish — read M4 and confirm the exchange succeeded.
//
// M4 is the accessory's acknowledgment: State 4, and either no error (success)
// or kTLVType_Error with a code (failure). Returns the shared secret derived
// from X25519, which becomes the session key for encrypted communication.

import { Effect, Option, Redacted, Schema } from "effect"
import { TlvType } from "../../Generated/index.ts"
import { Items, find } from "../../Tlv8/index.ts"
import { required } from "../Required.ts"
import { Refused } from "../Errors.ts"

export const finish = (
  m4Bytes: Uint8Array,
  sharedSecret: Redacted.Redacted<Uint8Array>
): Effect.Effect<Redacted.Redacted<Uint8Array>, Refused> =>
  Effect.gen(function*() {
    const m4Items = yield* Schema.decodeUnknownEffect(Items)(m4Bytes)
    const stateBytes = yield* required(m4Items, TlvType.State, "kTLVType_State")
    const state = stateBytes[0]

    if (state !== 4) {
      const errorBytes = find(m4Items, TlvType.Error)
      if (Option.isSome(errorBytes)) {
        const error = Option.getOrThrow(errorBytes)[0]
        return yield* Effect.fail(new Refused({ error }))
      }
    }

    const errorBytes = find(m4Items, TlvType.Error)
    if (Option.isSome(errorBytes)) {
      const error = Option.getOrThrow(errorBytes)[0]
      return yield* Effect.fail(new Refused({ error }))
    }

    return sharedSecret
  })
