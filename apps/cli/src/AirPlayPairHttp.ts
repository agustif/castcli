// One TCP connection for pair-setup, pair-verify, then HAP-encrypted HTTP.
//
// Apple TV authorizes pair-setup on the socket that called pair-pin-start.
// After pair-verify M4 the same socket expects HAP IP frames (2-byte LE
// length + ChaCha20-Poly1305) wrapping HTTP/1.1, not a new plaintext request.

import * as crypto from "node:crypto"
import { Effect } from "effect"
import { EncryptedSession as Encrypted } from "@castcli/airplay"
import { HapHttpClient } from "@castcli/platform"

export interface PairHttp {
  readonly get: (path: string) => Effect.Effect<{ status: number; body: Uint8Array }, unknown, Encrypted.Suite>
  readonly post: (
    path: string,
    body: Uint8Array,
    contentType?: string,
    extraHeaders?: Record<string, string>
  ) => Effect.Effect<{ status: number; body: Uint8Array }, unknown, Encrypted.Suite>
  readonly exchange: (
    method: string,
    path: string,
    body: Uint8Array,
    contentType: string,
    extraHeaders?: Record<string, string>,
    protocol?: string
  ) => Effect.Effect<{ status: number; body: Uint8Array }, unknown, Encrypted.Suite>
  readonly enableEncryption: (session: Encrypted.EncryptedSession) => void
  readonly setReadTimeout: (ms: number) => void
  readonly destroy: () => void
}

export const connect = (host: string, port: number): PairHttp => {
  const dacp = crypto.randomBytes(8).toString("hex").toUpperCase()
  const remote = String(crypto.randomInt(1, 0xffffffff))

  let client: HapHttpClient.HapHttpClient | undefined

  const ensureClient = Effect.gen(function* () {
    if (client !== undefined) {
      return client
    }
    client = yield* HapHttpClient.make(host, port, dacp, remote)
    return client
  })

  return {
    get: (path) =>
      Effect.gen(function* () {
        const c = yield* ensureClient
        return yield* c.get(path)
      }),
    post: (path, body, contentType, extraHeaders) =>
      Effect.gen(function* () {
        const c = yield* ensureClient
        return yield* c.post(path, body, contentType, extraHeaders)
      }),
    exchange: (method, path, body, contentType, extraHeaders, protocol) =>
      Effect.gen(function* () {
        const c = yield* ensureClient
        return yield* c.exchange(method, path, body, contentType, extraHeaders, protocol)
      }),
    enableEncryption: (session) => {
      Effect.runSync(
        Effect.gen(function* () {
          const c = yield* ensureClient
          yield* c.enableEncryption(session)
        })
      )
    },
    setReadTimeout: (ms) => {
      Effect.runSync(
        Effect.gen(function* () {
          const c = yield* ensureClient
          yield* c.setReadTimeout(ms)
        })
      )
    },
    destroy: () => {
      if (client !== undefined) {
        Effect.runSync(client.close())
      }
      client = undefined
    }
  }
}
