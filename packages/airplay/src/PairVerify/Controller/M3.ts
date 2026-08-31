/**
 * M3 — verify the accessory's signature and send ours.
 *
 * Reads M2 (accessory's ephemeral public key and encrypted signature), derives
 * the shared secret, verifies the accessory is who it says it is, then sends
 * our own encrypted signature.
 *
 * @since 0.1.0
 */
import { Effect, Match, Option, Redacted, Schema, SchemaIssue } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { TlvType } from "../../Generated/index.ts"
import { find, Items } from "../../Tlv8/index.ts"
import { Nonce, Suite, type ForgedFrame } from "../../Suite/index.ts"
import { exactly, required } from "../Required.ts"
import { Info as VocabInfo, Nonce as VocabNonce, Salt as VocabSalt } from "../Vocabulary.ts"
import { PeerUnknown, Refused, SignatureRejected } from "../Errors.ts"
import type { Pairing } from "../../PairSetup/Controller/Pairing.ts"

/** The State byte this message answers, and the one it sends. */
const ANSWERING = 2
const STATE = 3

/** Ed25519 signature is 64 bytes. */
const SIGNATURE_BYTES = 64

/**
 * Pair-verify Ed25519 message: signer X25519 PK || pairing ID || peer X25519 PK.
 *
 * HAPPairingPairVerify.c:
 *   AccessoryInfo  = AccessoryCvPK || AccessoryPairingID || iOSDeviceCvPK
 *   iOSDeviceInfo  = iOSDeviceCvPK || iOSDevicePairingID || AccessoryCvPK
 * Those are the ephemeral Curve25519 public keys, not the shared secret and
 * not the long-term Ed25519 keys. Signing still uses the long-term Ed25519 key.
 */
const pairVerifyInfo = (options: {
  readonly signerCvPK: Uint8Array
  readonly identifier: Uint8Array
  readonly peerCvPK: Uint8Array
}): Uint8Array => {
  const info = new Uint8Array(
    options.signerCvPK.length + options.identifier.length + options.peerCvPK.length
  )
  info.set(options.signerCvPK)
  info.set(options.identifier, options.signerCvPK.length)
  info.set(options.peerCvPK, options.signerCvPK.length + options.identifier.length)
  return info
}

/**
 * Read M2 and produce M3.
 *
 * **Details**
 *
 * M2 contains the accessory's ephemeral public key and an encrypted sub-TLV
 * with its pairing identifier and signature. We derive the X25519 shared secret,
 * decrypt the sub-TLV, verify the accessory's signature proves it holds the
 * long-term key we paired with, then send our own encrypted signature.
 *
 * **Gotchas**
 *
 * The pairing must be supplied by the caller — this function looks up the
 * accessory's long-term public key from the pairing record to verify its
 * signature. Without a valid pairing, verification fails with PeerUnknown.
 *
 * @example
 * ```ts
 * import { Effect, Option } from "effect"
 *
 * declare const m2Response: Uint8Array
 * declare const ephemeralKeys: { publicKey: Uint8Array; privateKey: Uint8Array }
 * declare const pairing: Pairing
 * declare const controllerIdentity: { identifier: string; keys: KeyPair }
 * 
 * const request = yield* m3(m2Response, {
 *   ephemeralKeys,
 *   pairing,
 *   controllerIdentity
 * })
 * ```
 *
 * @category messages
 * @since 0.1.0
 */
export const m3 = (
  m2Response: Uint8Array,
  options: {
    readonly ephemeralKeys: {
      readonly publicKey: Uint8Array
      readonly privateKey: Uint8Array
    }
    readonly pairing: Pairing
    readonly controllerIdentity: {
      readonly identifier: string
      readonly keys: {
        readonly publicKey: Uint8Array
        readonly privateKey: Redacted.Redacted<Uint8Array>
      }
    }
  }
): Effect.Effect<
  Uint8Array,
  | PeerUnknown
  | Refused
  | SignatureRejected
  | ForgedFrame
  | PlatformError
  | Schema.SchemaError
  | SchemaIssue.Issue,
  Suite
> =>
  Effect.gen(function*() {
    const items = yield* Schema.decodeUnknownEffect(Items)(m2Response)
    
    const stateItem = yield* required(items, TlvType.State, "kTLVType_State")
    yield* Effect.when(
      Effect.fail(
        new SchemaIssue.InvalidValue(undefined, { message: "expected state 2" })
      ),
      Effect.succeed(stateItem[0] !== ANSWERING)
    )

    const errorItem = find(items, TlvType.Error)
    yield* Option.match(errorItem, {
      onNone: () => Effect.void,
      onSome: (errorBytes) =>
        Effect.flatMap(
          Schema.decodeEffect(Schema.Number)(errorBytes[0] ?? 0),
          (errorCode) =>
            Match.value(errorCode).pipe(
              Match.when(1, () => Effect.fail(new Refused({ error: 1 }))),
              Match.when(2, () => Effect.fail(new Refused({ error: 2 }))),
              Match.when(3, () => Effect.fail(new Refused({ error: 3 }))),
              Match.when(4, () => Effect.fail(new Refused({ error: 4 }))),
              Match.when(5, () => Effect.fail(new Refused({ error: 5 }))),
              Match.when(6, () => Effect.fail(new Refused({ error: 6 }))),
              Match.when(7, () => Effect.fail(new Refused({ error: 7 }))),
              Match.orElse(() => Effect.fail(new Refused({ error: 1 })))
            )
        )
    })

    const accessoryEphemeralPublic = yield* exactly(
      items,
      TlvType.PublicKey,
      "kTLVType_PublicKey",
      32
    )

    const encryptedData = yield* required(items, TlvType.EncryptedData, "kTLVType_EncryptedData")

    const suite = yield* Suite
    const sharedSecret = yield* suite.x25519SharedSecret({
      privateKey: Redacted.make(options.ephemeralKeys.privateKey),
      publicKey: accessoryEphemeralPublic
    })

    const sessionKey = yield* suite.hkdfSha512({
      key: sharedSecret,
      salt: VocabSalt.PairVerifyEncrypt,
      info: VocabInfo.PairVerifyEncrypt
    })

    const subTlvBytes = yield* suite.open({
      key: sessionKey,
      nonce: yield* Nonce.label(VocabNonce.PVMsg02),
      ciphertextAndTag: encryptedData,
      associatedData: new Uint8Array()
    })

    const subTlv = yield* Schema.decodeUnknownEffect(Items)(subTlvBytes)
    
    const accessoryIdentifier = yield* required(subTlv, TlvType.Identifier, "kTLVType_Identifier")
    const accessorySignature = yield* exactly(
      subTlv,
      TlvType.Signature,
      "kTLVType_Signature",
      SIGNATURE_BYTES
    )

    const accessoryInfo = pairVerifyInfo({
      signerCvPK: accessoryEphemeralPublic,
      identifier: accessoryIdentifier,
      peerCvPK: options.ephemeralKeys.publicKey
    })

    const signatureValid = yield* suite.ed25519Verify({
      publicKey: options.pairing.accessory.publicKey,
      message: accessoryInfo,
      signature: accessorySignature
    })

    yield* Effect.when(
      Effect.fail(new SignatureRejected({ side: "accessory" })),
      Effect.succeed(!signatureValid)
    )

    const controllerIdentifier = new TextEncoder().encode(options.controllerIdentity.identifier)
    const controllerInfo = pairVerifyInfo({
      signerCvPK: options.ephemeralKeys.publicKey,
      identifier: controllerIdentifier,
      peerCvPK: accessoryEphemeralPublic
    })

    const controllerSignature = yield* suite.ed25519Sign({
      privateKey: options.controllerIdentity.keys.privateKey,
      message: controllerInfo
    })

    const controllerSubTlv = yield* Schema.encodeEffect(Items)([
      { type: TlvType.Identifier, value: controllerIdentifier },
      { type: TlvType.Signature, value: controllerSignature }
    ])

    const controllerEncrypted = yield* suite.seal({
      key: sessionKey,
      nonce: yield* Nonce.label(VocabNonce.PVMsg03),
      plaintext: controllerSubTlv,
      associatedData: new Uint8Array()
    })

    return yield* Schema.encodeEffect(Items)([
      { type: TlvType.State, value: Uint8Array.of(STATE) },
      { type: TlvType.EncryptedData, value: controllerEncrypted }
    ])
  })
