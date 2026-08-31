// Encrypted HTTP control channel after pair-verify.
//
// Real Apple TVs expect ChaCha20-Poly1305 framing on control POSTs after
// pair-verify completes. Each HTTP frame is length-prefixed (2 bytes big-endian)
// and encrypted with an incrementing nonce counter. The session keys are derived
// from the pair-verify shared secret via HKDF.

import { Effect, Redacted, Ref } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Suite as SuiteService, Nonce, ForgedFrame } from "./Suite/index.ts"
import { Info as GeneratedInfo, Salt as GeneratedSalt } from "./Generated/index.ts"

export { SuiteService as Suite }

/**
 * Session keys derived after pair-verify.
 * 
 * Controller writes with writeKey, reads with readKey.
 * Accessory does the inverse.
 */
export interface SessionKeys {
  readonly readKey: Redacted.Redacted<Uint8Array>
  readonly writeKey: Redacted.Redacted<Uint8Array>
}

/**
 * Derive control-channel session keys from pair-verify shared secret.
 * 
 * Uses HKDF-SHA512 with Control-Salt and the two encryption-key infos
 * from the HAP spec.
 */
export const deriveSessionKeys = (
  sharedSecret: Redacted.Redacted<Uint8Array>
): Effect.Effect<SessionKeys, PlatformError, SuiteService> =>
  Effect.gen(function*() {
    const suite = yield* SuiteService

    const readKey = yield* suite.hkdfSha512({
      key: sharedSecret,
      salt: GeneratedSalt.Control,
      info: GeneratedInfo.ControlRead
    })

    const writeKey = yield* suite.hkdfSha512({
      key: sharedSecret,
      salt: GeneratedSalt.Control,
      info: GeneratedInfo.ControlWrite
    })

    return { readKey, writeKey }
  })

/**
 * Encrypted session state: keys and nonce counters.
 * 
 * The nonce counter increments per frame sent. HAP uses little-endian
 * counter encoding in the 8-byte suffix of the 12-byte nonce.
 */
export interface EncryptedSession {
  readonly keys: SessionKeys
  readonly writeNonce: Ref.Ref<bigint>
  readonly readNonce: Ref.Ref<bigint>
}

/**
 * Create an encrypted session after pair-verify.
 */
export const make = (keys: SessionKeys): Effect.Effect<EncryptedSession> =>
  Effect.gen(function*() {
    const writeNonce = yield* Ref.make(BigInt(0))
    const readNonce = yield* Ref.make(BigInt(0))
    return { keys, writeNonce, readNonce }
  })

/**
 * Encrypt an HTTP request body for the control channel.
 * 
 * Returns: 2-byte big-endian length prefix || ciphertext || 16-byte tag
 */
export const encryptFrame = (
  session: EncryptedSession,
  plaintext: Uint8Array
): Effect.Effect<Uint8Array, PlatformError, SuiteService> =>
  Effect.gen(function*() {
    const suite = yield* SuiteService
    const counter = yield* Ref.getAndUpdate(session.writeNonce, (n) => n + BigInt(1))
    
    const nonce = yield* Nonce.counter(counter)
    
    const ciphertextWithTag = yield* suite.seal({
      key: session.keys.writeKey,
      nonce,
      plaintext,
      associatedData: new Uint8Array()
    })

    const length = ciphertextWithTag.length
    const frame = new Uint8Array(2 + length)
    frame[0] = (length >> 8) & 0xff
    frame[1] = length & 0xff
    frame.set(ciphertextWithTag, 2)
    
    return frame
  })

/**
 * Decrypt an HTTP response body from the control channel.
 * 
 * Expects: 2-byte big-endian length prefix || ciphertext || 16-byte tag
 */
export const decryptFrame = (
  session: EncryptedSession,
  frame: Uint8Array
): Effect.Effect<Uint8Array, PlatformError | ForgedFrame, SuiteService> =>
  Effect.gen(function*() {
    const suite = yield* SuiteService
    
    yield* Effect.when(
      Effect.fail({ _tag: "FrameTooShort" as const, message: "Frame too short" }),
      Effect.succeed(frame.length < 2)
    )

    const lengthHigh = frame[0] ?? 0
    const lengthLow = frame[1] ?? 0
    const length = (lengthHigh << 8) | lengthLow
    const payload = frame.slice(2, 2 + length)
    
    const counter = yield* Ref.getAndUpdate(session.readNonce, (n) => n + BigInt(1))
    const nonce = yield* Nonce.counter(counter)
    
    return yield* suite.open({
      key: session.keys.readKey,
      nonce,
      ciphertextAndTag: payload,
      associatedData: new Uint8Array()
    })
  })
