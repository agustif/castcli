// One TCP connection for pair-setup, pair-verify, then HAP-encrypted HTTP.
//
// Apple TV authorizes pair-setup on the socket that called pair-pin-start.
// macOS AirPlay Receiver 403s pair-pin-start; skip it and pair-setup on the
// /info socket instead. After pair-verify M4 the same socket expects HAP IP
// frames wrapping HTTP/1.1.

import * as crypto from "node:crypto"
import { Effect, Scope } from "effect"
import * as Airplay from "@castcli/airplay"
import { HapHttpClient } from "@castcli/platform"

export interface PairHttp {
  readonly get: (
    path: string
  ) => Effect.Effect<{ status: number; body: Uint8Array }, unknown, Airplay.Suite.Suite>
  readonly post: (
    path: string,
    body: Uint8Array,
    contentType?: string,
    extraHeaders?: Record<string, string>
  ) => Effect.Effect<{ status: number; body: Uint8Array }, unknown, Airplay.Suite.Suite>
  readonly exchange: (
    method: string,
    path: string,
    body: Uint8Array,
    contentType: string,
    extraHeaders?: Record<string, string>,
    protocol?: string
  ) => Effect.Effect<{ status: number; body: Uint8Array }, unknown, Airplay.Suite.Suite>
  readonly enableEncryption: (
    session: Airplay.EncryptedSession.EncryptedSession
  ) => Effect.Effect<void, unknown, Airplay.Suite.Suite>
  readonly setReadTimeout: (ms: number) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

export const connect = (
  host: string,
  port: number
): Effect.Effect<PairHttp, unknown, Scope.Scope | Airplay.Suite.Suite> => {
  const dacp = crypto.randomBytes(8).toString("hex").toUpperCase()
  const remote = String(crypto.randomInt(1, 0xffffffff))

  return Effect.gen(function* () {
    const client = yield* HapHttpClient.make(host, port, dacp, remote)

    return {
      get: (path) => client.get(path),
      post: (path, body, contentType, extraHeaders) => client.post(path, body, contentType, extraHeaders),
      exchange: (method, path, body, contentType, extraHeaders, protocol) =>
        client.exchange(method, path, body, contentType, extraHeaders, protocol),
      enableEncryption: (session) => client.enableEncryption(session),
      setReadTimeout: (ms) => client.setReadTimeout(ms),
      close: Effect.interrupt
    }
  })
}
