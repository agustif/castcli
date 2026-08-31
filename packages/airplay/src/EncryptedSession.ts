// Encrypted HTTP control channel after pair-verify.
//
// HAP IP (spec 5.2.2 / pyatv HAPSession): plaintext is split into 1024-byte
// chunks. Each chunk is ChaCha20-Poly1305 with AAD = 2-byte little-endian
// plaintext length, nonce = 4 zero bytes || 8-byte little-endian counter.
// The wire is: length || ciphertext || 16-byte tag. After M4, that framing
// wraps entire HTTP/1.1 messages on the same TCP socket — not an HTTP body.

import { Effect, Redacted, Ref, Data } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Suite as SuiteService, Nonce, ForgedFrame } from "./Suite/index.ts"
import { Info as GeneratedInfo, Salt as GeneratedSalt } from "./Generated/index.ts"

export { SuiteService as Suite }

export class FrameTooShort extends Data.TaggedError("FrameTooShort")<{
  readonly message: string
}> {}

const FRAME_PLAINTEXT = 1024
const TAG = 16

export interface SessionKeys {
  readonly readKey: Redacted.Redacted<Uint8Array>
  readonly writeKey: Redacted.Redacted<Uint8Array>
}

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

export interface EncryptedSession {
  readonly keys: SessionKeys
  readonly writeNonce: Ref.Ref<bigint>
  readonly readNonce: Ref.Ref<bigint>
}

export const make = (keys: SessionKeys): Effect.Effect<EncryptedSession> =>
  Effect.gen(function*() {
    const writeNonce = yield* Ref.make(BigInt(0))
    const readNonce = yield* Ref.make(BigInt(0))
    return { keys, writeNonce, readNonce }
  })

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Encrypt a complete HTTP message (or any payload) into HAP IP frames. */
export const encryptMessage = (
  session: EncryptedSession,
  plaintext: Uint8Array
): Effect.Effect<Uint8Array, PlatformError, SuiteService> =>
  Effect.gen(function*() {
    const suite = yield* SuiteService
    const frames: Uint8Array[] = []
    let offset = 0
    while (offset < plaintext.byteLength) {
      const end = Math.min(offset + FRAME_PLAINTEXT, plaintext.byteLength)
      const chunk = plaintext.subarray(offset, end)
      const counter = yield* Ref.getAndUpdate(session.writeNonce, (n) => n + BigInt(1))
      const nonce = yield* Nonce.counter(counter)
      const length = new Uint8Array(2)
      length[0] = chunk.byteLength & 0xff
      length[1] = (chunk.byteLength >> 8) & 0xff
      const sealed = yield* suite.seal({
        key: session.keys.writeKey,
        nonce,
        plaintext: chunk,
        associatedData: length
      })
      frames.push(length, sealed)
      offset = end
    }
    return concat(frames)
  })

/**
 * Decrypt as many complete HAP frames as `buffer` holds.
 * Returns leftover ciphertext that is not yet a full frame.
 */
export const decryptAvailable = (
  session: EncryptedSession,
  buffer: Uint8Array
): Effect.Effect<{ plaintext: Uint8Array; rest: Uint8Array }, PlatformError | ForgedFrame, SuiteService> =>
  Effect.gen(function*() {
    const suite = yield* SuiteService
    const chunks: Uint8Array[] = []
    let offset = 0
    while (
      offset + 2 <= buffer.byteLength &&
      offset + 2 + ((buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8)) + TAG <= buffer.byteLength
    ) {
      const plainLen = (buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8)
      const frameLen = 2 + plainLen + TAG
      const length = buffer.subarray(offset, offset + 2)
      const sealed = buffer.subarray(offset + 2, offset + frameLen)
      const counter = yield* Ref.getAndUpdate(session.readNonce, (n) => n + BigInt(1))
      const nonce = yield* Nonce.counter(counter)
      const plain = yield* suite.open({
        key: session.keys.readKey,
        nonce,
        ciphertextAndTag: sealed,
        associatedData: length
      })
      chunks.push(plain)
      offset += frameLen
    }
    return {
      plaintext: concat(chunks),
      rest: buffer.subarray(offset)
    }
  })

/** @deprecated alias — body-only framing; HAP wraps the whole HTTP message. */
export const encryptFrame = encryptMessage
