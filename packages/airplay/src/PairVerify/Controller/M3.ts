// M3 — controller sends encrypted proof: signature over both ephemeral keys.
//
// Decodes M2 (accessory's ephemeral public key + encrypted data), computes
// X25519 shared secret, derives ChaCha20-Poly1305 key, opens M2's sub-TLV to
// read accessory's identifier and signature, verifies that signature, then
// seals M3's sub-TLV containing controller's identifier and signature.

import { Effect, Option, Redacted, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { PairingError, TlvType } from "../../Generated/index.ts"
import { Items, find } from "../../Tlv8/index.ts"
import { exactly, required } from "../Required.ts"
import { Info, Nonce as NonceLabel, Salt } from "../Vocabulary.ts"
import * as SuiteNS from "../../Suite/index.ts"
import type { KeyPair } from "../../Suite/index.ts"
import { PeerUnknown, Refused, SignatureRejected } from "../Errors.ts"

const STATE = 3

export interface Proved {
  readonly accessoryIdentifier: Uint8Array
  readonly accessoryPublicKey: Uint8Array
}

const openM2SubTlv = (
  sealed: Uint8Array,
  sessionKey: Redacted.Redacted<Uint8Array>
) =>
  Effect.gen(function*() {
    const suite = yield* SuiteNS.Suite
    const nonce = yield* SuiteNS.Nonce.label(NonceLabel.PVMsg02)
    const plaintext = yield* suite.open({
      key: sessionKey,
      nonce,
      ciphertextAndTag: sealed,
      associatedData: new Uint8Array()
    })
    const items = yield* Schema.decodeUnknownEffect(Items)(plaintext)
    const identifier = yield* required(items, TlvType.Identifier, "kTLVType_Identifier")
    const signature = yield* exactly(items, TlvType.Signature, "kTLVType_Signature", 64)
    return { identifier, signature }
  })

const sealM3SubTlv = (
  controllerIdentifier: Uint8Array,
  controllerSignature: Uint8Array,
  sessionKey: Redacted.Redacted<Uint8Array>
) =>
  Effect.gen(function*() {
    const suite = yield* SuiteNS.Suite
    const plainItems = yield* Schema.encodeEffect(Items)([
      { type: TlvType.Identifier, value: controllerIdentifier },
      { type: TlvType.Signature, value: controllerSignature }
    ])
    const nonce = yield* SuiteNS.Nonce.label(NonceLabel.PVMsg03)
    return yield* suite.seal({
      key: sessionKey,
      nonce,
      plaintext: plainItems,
      associatedData: new Uint8Array()
    })
  })

export const m3 = (
  m2Bytes: Uint8Array,
  controllerEphemeral: KeyPair,
  controllerIdentifier: Uint8Array,
  controllerLongTermKey: Redacted.Redacted<Uint8Array>,
  accessoryPublicKey: Uint8Array
): Effect.Effect<{ request: Uint8Array; proved: Proved }, PlatformError | PeerUnknown | SignatureRejected | Refused, SuiteNS.Suite> =>
  Effect.gen(function*() {
    const suite = yield* SuiteNS.Suite
    const m2Items = yield* Schema.decodeUnknownEffect(Items)(m2Bytes)

    const stateBytes = yield* required(m2Items, TlvType.State, "kTLVType_State")
    const state = stateBytes[0]
    if (state !== 2) {
      const errorBytes = find(m2Items, TlvType.Error)
      if (Option.isSome(errorBytes)) {
        const error = Option.getOrThrow(errorBytes)[0]
        return yield* Effect.fail(new Refused({ error: error as PairingError }))
      }
      return yield* Effect.fail(
        new Refused({ error: PairingError.Unknown })
      )
    }

    const accessoryEphemeralPublic = yield* exactly(
      m2Items,
      TlvType.PublicKey,
      "kTLVType_PublicKey",
      32
    )
    const encryptedData = yield* required(m2Items, TlvType.EncryptedData, "kTLVType_EncryptedData")

    const sharedSecret = yield* suite.x25519SharedSecret({
      privateKey: controllerEphemeral.privateKey,
      publicKey: accessoryEphemeralPublic
    })

    const sessionKey = yield* suite.hkdfSha512({
      key: sharedSecret,
      salt: Salt.PairVerifyEncrypt,
      info: Info.PairVerifyEncrypt
    })

    const { identifier: accessoryIdentifier, signature: accessorySignature } = yield* openM2SubTlv(
      encryptedData,
      sessionKey
    )

    const accessoryInfo = new Uint8Array([
      ...accessoryEphemeralPublic,
      ...accessoryIdentifier,
      ...controllerEphemeral.publicKey
    ])
    const accessorySignatureValid = yield* suite.ed25519Verify({
      publicKey: accessoryPublicKey,
      message: accessoryInfo,
      signature: accessorySignature
    })

    if (!accessorySignatureValid) {
      return yield* Effect.fail(new SignatureRejected({ side: "accessory" }))
    }

    const controllerInfo = new Uint8Array([
      ...controllerEphemeral.publicKey,
      ...controllerIdentifier,
      ...accessoryEphemeralPublic
    ])
    const controllerSignature = yield* suite.ed25519Sign({
      privateKey: controllerLongTermKey,
      message: controllerInfo
    })

    const m3EncryptedData = yield* sealM3SubTlv(
      controllerIdentifier,
      controllerSignature,
      sessionKey
    )

    const request = yield* Schema.encodeEffect(Items)([
      { type: TlvType.State, value: new Uint8Array([STATE]) },
      { type: TlvType.EncryptedData, value: m3EncryptedData }
    ])

    return {
      request,
      proved: {
        accessoryIdentifier,
        accessoryPublicKey
      }
    }
  })
