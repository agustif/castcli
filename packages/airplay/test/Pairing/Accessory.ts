// The television, emulated far enough to pair with — and no further.
//
// **This file is a stand-in.** `src/PairSetup/Accessory/` holds the accessory's
// models — its state machine, its attempt counter, its identity, the shape of
// the pairing it ends up with — and, at the time this was written, nothing that
// turns a request into a response. So the three responses are assembled here.
// When the real responder lands, this file should be deleted and `respond`
// re-pointed at it; what is written below is deliberately the *shape* that
// responder will have, so that the swap is an import change.
//
// Until then, be clear about what this does and does not prove. A controller
// checked against an accessory written by the same hand can only fail when the
// two disagree, and two halves written together tend not to. That is why every
// constant below is quoted from the vendored C source as a literal rather than
// imported from `Generated`:
//
//   - the HKDF salts and infos are spelled out, so that a wrong string in
//     `Generated/Strings.ts` is a mismatch here rather than a shared mistake;
//   - the sub-TLV is sealed and opened through `Suite` directly rather than
//     through `PairSetup/Controller/Sub/`, so that a wrong tag layout or a wrong
//     associated-data choice there is caught instead of agreed with;
//   - the signed device info is laid out here rather than imported from
//     `Controller/DeviceInfo.ts`, for the same reason — a field order both sides
//     got wrong the same way would verify perfectly.
//
// What it does use from `src` is everything that is *state* rather than
// agreement: `Request.decode`, `State`, `Attempts`, `Identity.fromSeed`,
// `Pairing`, and the whole of `Srp.Server`, which is the half of the SRP that
// Apple's own vectors check. Those are compositions, not duplications.

import { Crypto, Effect, Option, Redacted, Ref } from "effect"
import type { Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { PairingError, PairingMethod, SrpUsername, TlvType } from "../../src/Generated/index.ts"
import { byte, type Item } from "../../src/Tlv8/index.ts"
import { type ForgedFrame, Nonce, Suite } from "../../src/Suite/index.ts"
import { Errors as SrpErrors, Group, Server, Verifier } from "../../src/Srp/index.ts"
import * as Attempts from "../../src/PairSetup/Accessory/Attempts.ts"
import { MalformedMessage, UnexpectedState } from "../../src/PairSetup/Accessory/Errors.ts"
import { fromSeed, type Identity } from "../../src/PairSetup/Accessory/Identity.ts"
import { ADMIN, MAX_IDENTIFIER_BYTES, type Pairing } from "../../src/PairSetup/Accessory/Pairing.ts"
import * as Request from "../../src/PairSetup/Accessory/Request.ts"
import { State } from "../../src/PairSetup/Accessory/State.ts"
import { decode, encode, item } from "./Support.ts"

/** `SRP_SALT_BYTES`. Every ADK accessory sends sixteen. */
const SALT_BYTES = 16

/** `ED25519_PUBLIC_KEY_BYTES` and `ED25519_BYTES`. */
const PUBLIC_KEY_BYTES = 32
const SIGNATURE_BYTES = 64

/**
 * The four HKDF derivations of pair-setup, quoted from
 * `packages/airplay/vendor/HAPPairingPairSetup.c` rather than imported.
 *
 * Two of these are the encryption key, derived identically on both sides; the
 * other two are the signing values, and they are the pair most easily confused.
 * Swapping the controller's for the accessory's produces a signature that is
 * well-formed, verifies against nothing, and is reported as an impostor.
 */
const DERIVATION = {
  encryptSalt: "Pair-Setup-Encrypt-Salt",
  encryptInfo: "Pair-Setup-Encrypt-Info",
  controllerSignSalt: "Pair-Setup-Controller-Sign-Salt",
  controllerSignInfo: "Pair-Setup-Controller-Sign-Info",
  accessorySignSalt: "Pair-Setup-Accessory-Sign-Salt",
  accessorySignInfo: "Pair-Setup-Accessory-Sign-Info"
} as const

/**
 * `X || pairing identifier || long-term public key`.
 *
 * Written out here rather than imported from `Controller/DeviceInfo.ts`. The
 * layout is the one thing both ends must agree on that no length check can
 * verify — the identifier is variable-width and sits between two 32-byte fields
 * precisely so the concatenation stays unambiguous — and a test that imported
 * the controller's layout could not tell a correct one from a consistently wrong
 * one.
 */
const deviceInfo = (
  x: Redacted.Redacted<Uint8Array>,
  identifier: Uint8Array,
  publicKey: Uint8Array
): Uint8Array => {
  const secret = Redacted.value(x)
  const message = new Uint8Array(secret.length + identifier.length + publicKey.length)
  message.set(secret)
  message.set(identifier, secret.length)
  message.set(publicKey, secret.length + identifier.length)
  return message
}

/** The item a message cannot do without, named when it is not there. */
const required = (
  items: ReadonlyArray<Item>,
  type: number,
  name: string
): Effect.Effect<Uint8Array, MalformedMessage> =>
  Option.match(
    Option.fromNullishOr(items.find((entry) => entry.type === type)),
    {
      onNone: () => Effect.fail(new MalformedMessage({ item: name, reason: "missing" })),
      onSome: (entry: Item) => Effect.succeed(entry.value)
    }
  )

/** The same, with the width the primitive downstream insists on. */
const exactly = (
  items: ReadonlyArray<Item>,
  type: number,
  name: string,
  length: number
): Effect.Effect<Uint8Array, MalformedMessage> =>
  Effect.flatMap(required(items, type, name), (value) =>
    value.length === length ? Effect.succeed(value) : Effect.fail(
      new MalformedMessage({
        item: name,
        reason: `expected ${length} bytes, got ${value.length}`
      })
    ))

/**
 * The step this accessory is at, against the step the request announces.
 *
 * Both are checked, not just one. The ADK dispatches on the byte and then each
 * handler asserts it again; collapsing that into one comparison is the only way
 * to be sure the value dispatched on is the value validated.
 */
const expect = (
  received: number,
  expected: number
): Effect.Effect<void, UnexpectedState> =>
  received === expected
    ? Effect.void
    : Effect.fail(new UnexpectedState({ expected, received }))

/** Everything a test wants to ask an emulated television. */
export interface Accessory {
  /** Its pairing identifier and long-term Ed25519 pair, fixed at construction. */
  readonly identity: Identity
  /**
   * Answer one request with one response.
   *
   * Bytes in, bytes out, and no socket anywhere — which is the whole point.
   * Fails only when the request could not be *processed*; a wrong setup code or
   * a signature that does not verify is a well-formed response carrying
   * `kTLVType_Error`, exactly as HAP defines it, and comes back as bytes.
   */
  readonly respond: (
    request: Uint8Array
  ) => Effect.Effect<
    Uint8Array,
    | ForgedFrame
    | MalformedMessage
    | PlatformError
    | Schema.SchemaError
    | SrpErrors.InvalidPublicKey
    | UnexpectedState,
    Crypto.Crypto | Suite
  >
  /** The pairing it stored, once M5's signature verified. */
  readonly paired: Effect.Effect<Option.Option<Pairing>>
  /** Consecutive wrong setup codes, for the lockout tests. */
  readonly failures: Effect.Effect<number>
}

/**
 * An accessory holding a setup code, waiting for M1.
 *
 * `attemptLimit` is a parameter rather than `Attempts.LIMIT` for the reason that
 * module gives: a test that had to fail a hundred times to reach the lockout is
 * a test nobody writes.
 */
export const make = (options: {
  /** The code on the screen, dashes and all — it is hashed as displayed. */
  readonly setupCode: string
  readonly pairingId: string
  /** The 32-byte Ed25519 seed. Fixed, so the pairing is the same every run. */
  readonly seed: Redacted.Redacted<Uint8Array>
  readonly attemptLimit: number
}): Effect.Effect<Accessory, PlatformError, Suite> =>
  Effect.gen(function*() {
    const identity = yield* fromSeed({ pairingId: options.pairingId, seed: options.seed })
    const attempts = yield* Attempts.make(options.attemptLimit)
    const state = yield* Ref.make<State>(State.AwaitingM1())
    const stored = yield* Ref.make(Option.none<Pairing>())

    /**
     * `HAPPairingPairSetupGetErrorResponse`: a State and an Error, and nothing
     * else. Not a failure — the exchange ended, and this is how it says so.
     */
    const refuse = (
      answering: number,
      code: number
    ): Effect.Effect<Uint8Array, Schema.SchemaError> =>
      Effect.flatMap(
        Ref.set(state, State.AwaitingM1()),
        () =>
          encode([
            item(TlvType.State, Uint8Array.of(answering)),
            item(TlvType.Error, Uint8Array.of(code))
          ])
      )

    /** M1 → M2: a fresh salt, a fresh `b`, and B. */
    const begin = (
      request: Request.Request
    ): Effect.Effect<
      Uint8Array,
      MalformedMessage | PlatformError | Schema.SchemaError,
      Crypto.Crypto
    > =>
      Effect.gen(function*() {
        const method = yield* Option.match(byte(request.items, TlvType.Method), {
          onNone: () =>
            Effect.fail(
              new MalformedMessage({
                item: "kTLVType_Method",
                reason: "missing, or not exactly one byte"
              })
            ),
          onSome: Effect.succeed
        })
        // `PairSetupWithAuth` would commit this accessory to producing an Apple
        // Authentication Coprocessor certificate in M4, which it cannot. HAP
        // answers a method it does not implement with `Unavailable`.
        yield* method === PairingMethod.PairSetup ? Effect.void : Effect.fail(
          new MalformedMessage({
            item: "kTLVType_Method",
            reason: `pair-setup only; got method ${method}`
          })
        )

        const crypto = yield* Crypto.Crypto
        const salt = yield* crypto.randomBytes(SALT_BYTES)
        // Derived here, on each exchange, rather than stored — which is not what
        // a real accessory does, and is the one place this differs on purpose.
        // A real one computes `v` once at manufacture from a salt it keeps
        // forever; recomputing it means a test can change the setup code by
        // changing one argument.
        const verifier = yield* Verifier.verifier(Group.rfc5054, {
          username: SrpUsername,
          password: options.setupCode,
          salt
        })
        const srp = yield* Server.make(Group.rfc5054, {
          username: SrpUsername,
          salt,
          verifier,
          // Never pinned. Two exchanges with the same `b` and the same `a` share
          // a session key, which would let a test pass that reused a transcript.
          privateKey: Option.none()
        })
        yield* Ref.set(state, State.AwaitingM3({ srp }))
        return yield* encode([
          item(TlvType.State, Uint8Array.of(2)),
          item(TlvType.Salt, salt),
          item(TlvType.PublicKey, srp.publicKey)
        ])
      })

    /** M3 → M4: check the controller's proof, and answer with our own. */
    const prove = (
      request: Request.Request,
      srp: Server.Server
    ): Effect.Effect<
      Uint8Array,
      SrpErrors.InvalidPublicKey | MalformedMessage | PlatformError | Schema.SchemaError,
      Crypto.Crypto | Suite
    > =>
      Effect.gen(function*() {
        const clientPublicKey = yield* required(
          request.items,
          TlvType.PublicKey,
          "kTLVType_PublicKey"
        )
        const m1 = yield* exactly(request.items, TlvType.Proof, "kTLVType_Proof", 64)
        const accepted = yield* srp.verify({ clientPublicKey, m1 })

        yield* attempts.reset
        const suite = yield* Suite
        const srpSessionKey = Redacted.make(accepted.sessionKey)
        const encryptionKey = yield* suite.hkdfSha512({
          key: srpSessionKey,
          salt: DERIVATION.encryptSalt,
          info: DERIVATION.encryptInfo
        })
        yield* Ref.set(state, State.AwaitingM5({ srpSessionKey, encryptionKey }))
        return yield* encode([
          item(TlvType.State, Uint8Array.of(4)),
          item(TlvType.Proof, accepted.m2)
        ])
      }).pipe(
        // A rejected proof is the wrong setup code, and it is the only failure
        // the attempt counter counts. `InvalidPublicKey` — A ≡ 0 — is left to
        // fail: it is an attack rather than a typing mistake, and the ADK
        // abandons the procedure rather than answering it.
        Effect.catchTag("SrpProofRejected", () =>
          Effect.flatMap(attempts.record, () => refuse(4, PairingError.Authentication)))
      )

    /** M5 → M6: read the controller's identity, then hand over our own. */
    const introduce = (
      request: Request.Request,
      keys: {
        readonly srpSessionKey: Redacted.Redacted<Uint8Array>
        readonly encryptionKey: Redacted.Redacted<Uint8Array>
      }
    ): Effect.Effect<
      Uint8Array,
      ForgedFrame | MalformedMessage | PlatformError | Schema.SchemaError,
      Suite
    > =>
      Effect.gen(function*() {
        const suite = yield* Suite
        const sealed = yield* required(
          request.items,
          TlvType.EncryptedData,
          "kTLVType_EncryptedData"
        )
        // A tag that does not verify here is *not* answered with
        // `Authentication`: by M5 the setup code has already been proved, so a
        // bad tag means the message was altered in flight. It is a failure, not
        // a refusal, which is why this is not wrapped.
        const plaintext = yield* suite.open({
          key: keys.encryptionKey,
          nonce: yield* Nonce.label("PS-Msg05"),
          ciphertextAndTag: sealed,
          associatedData: new Uint8Array()
        })
        const sub = yield* Effect.mapError(
          decode(plaintext),
          () =>
            new MalformedMessage({
              item: "the sub-TLV",
              reason: "decrypted, and is not a TLV8 payload"
            })
        )

        const identifier = yield* required(sub, TlvType.Identifier, "kTLVType_Identifier")
        yield* identifier.length <= MAX_IDENTIFIER_BYTES ? Effect.void : Effect.fail(
          new MalformedMessage({
            item: "kTLVType_Identifier",
            reason: `at most ${MAX_IDENTIFIER_BYTES} bytes, got ${identifier.length}`
          })
        )
        const publicKey = yield* exactly(
          sub,
          TlvType.PublicKey,
          "kTLVType_PublicKey",
          PUBLIC_KEY_BYTES
        )
        // Checked to the byte before it reaches the verifier. A 63-byte
        // signature that reached `ed25519Verify` would come back as a bad
        // argument, and one that came back `false` would read as an impostor.
        const signature = yield* exactly(
          sub,
          TlvType.Signature,
          "kTLVType_Signature",
          SIGNATURE_BYTES
        )

        const controllerX = yield* suite.hkdfSha512({
          key: keys.srpSessionKey,
          salt: DERIVATION.controllerSignSalt,
          info: DERIVATION.controllerSignInfo
        })
        const verified = yield* suite.ed25519Verify({
          publicKey,
          message: deviceInfo(controllerX, identifier, publicKey),
          signature
        })

        return yield* verified
          ? Effect.gen(function*() {
            yield* Ref.set(
              stored,
              Option.some({ identifier, publicKey, permissions: ADMIN })
            )
            const accessoryX = yield* suite.hkdfSha512({
              key: keys.srpSessionKey,
              salt: DERIVATION.accessorySignSalt,
              info: DERIVATION.accessorySignInfo
            })
            const ours = new TextEncoder().encode(identity.pairingId)
            const proof = yield* suite.ed25519Sign({
              privateKey: identity.keys.privateKey,
              message: deviceInfo(accessoryX, ours, identity.keys.publicKey)
            })
            const payload = yield* encode([
              item(TlvType.Identifier, ours),
              item(TlvType.PublicKey, identity.keys.publicKey),
              item(TlvType.Signature, proof)
            ])
            yield* Ref.set(state, State.AwaitingM1())
            return yield* encode([
              item(TlvType.State, Uint8Array.of(6)),
              item(
                TlvType.EncryptedData,
                yield* suite.seal({
                  key: keys.encryptionKey,
                  nonce: yield* Nonce.label("PS-Msg06"),
                  plaintext: payload,
                  associatedData: new Uint8Array()
                })
              )
            ])
          })
          // Answered with `Authentication`, and deliberately *not* counted as an
          // attempt: the setup code was already proved right at M4, and counting
          // this would let a controller with a broken Ed25519 lock the accessory
          // out of ever pairing.
          : refuse(6, PairingError.Authentication)
      })

    const respond: Accessory["respond"] = (request) =>
      Effect.gen(function*() {
        const decoded = yield* Request.decode(request)
        const current = yield* Ref.get(state)
        return yield* State.$match(current, {
          AwaitingM1: () =>
            Effect.flatMap(expect(decoded.state, 1), () =>
              Effect.flatMap(attempts.exhausted, (locked) =>
                // Consulted before any work is done, so a locked-out controller
                // does not even learn the salt. `MaxTries` is permanent in HAP:
                // the accessory will not pair again until it is reset.
                locked ? refuse(2, PairingError.MaxTries) : begin(decoded))),
          AwaitingM3: ({ srp }) =>
            Effect.flatMap(expect(decoded.state, 3), () => prove(decoded, srp)),
          AwaitingM5: (keys) =>
            Effect.flatMap(expect(decoded.state, 5), () => introduce(decoded, keys))
        })
      })

    return {
      identity,
      respond,
      paired: Ref.get(stored),
      failures: attempts.failed
    }
  })
