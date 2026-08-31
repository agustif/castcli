// Keep-alive HAP HTTP client using Effect Socket runtime.
//
// After pair-verify M4 the same socket expects HAP IP frames wrapping HTTP/1.1.

import * as Net from "node:net"
import { Effect, Deferred, Ref, Option } from "effect"
import { systemError } from "effect/PlatformError"
import type { PlatformError } from "effect/PlatformError"
import { EncryptedSession as Encrypted, Suite } from "@castcli/airplay"

export interface HapHttpClient {
  readonly get: (
    path: string
  ) => Effect.Effect<{ status: number; body: Uint8Array }, PlatformError | Suite.ForgedFrame, Encrypted.Suite>
  readonly post: (
    path: string,
    body: Uint8Array,
    contentType?: string,
    extraHeaders?: Record<string, string>
  ) => Effect.Effect<{ status: number; body: Uint8Array }, PlatformError | Suite.ForgedFrame, Encrypted.Suite>
  readonly exchange: (
    method: string,
    path: string,
    body: Uint8Array,
    contentType: string,
    extraHeaders?: Record<string, string>,
    protocol?: string
  ) => Effect.Effect<{ status: number; body: Uint8Array }, PlatformError | Suite.ForgedFrame, Encrypted.Suite>
  readonly enableEncryption: (session: Encrypted.EncryptedSession) => Effect.Effect<void>
  readonly setReadTimeout: (ms: number) => Effect.Effect<void>
  readonly close: () => Effect.Effect<void>
}

interface Config {
  readonly host: string
  readonly port: number
  readonly dacp: string
  readonly remote: string
}

interface State {
  socket: Option.Option<Net.Socket>
  session: Option.Option<Encrypted.EncryptedSession>
  readTimeoutMs: number
  incoming: Uint8Array
  waiters: Array<Deferred.Deferred<void, never>>
}

const tryParseHttp = (
  buf: Uint8Array
): Option.Option<{ status: number; body: Uint8Array; consumed: number }> => {
  const text = new TextDecoder("latin1").decode(buf)
  const sep = text.indexOf("\r\n\r\n")
  if (sep < 0) return Option.none()
  
  const header = text.substring(0, sep)
  const statusLine = header.split("\r\n")[0] ?? ""
  const status = Number(statusLine.split(" ")[1] ?? "0")
  const cl = /content-length:\s*(\d+)/i.exec(header)
  const len = cl === null ? 0 : Number(cl[1])
  const start = sep + 4
  
  if (buf.length < start + len) return Option.none()
  
  return Option.some({
    status,
    body: buf.slice(start, start + len),
    consumed: start + len
  })
}

const encodeRequest = (
  config: Config,
  method: string,
  path: string,
  body: Uint8Array,
  contentType: string,
  extraHeaders: Record<string, string>,
  protocol: string
): Uint8Array => {
  const headers = {
    "User-Agent": "AirPlay/320.20",
    Connection: "keep-alive",
    "X-Apple-HKP": "3",
    "X-Apple-Client-Name": "castcli",
    "DACP-ID": config.dacp,
    "Active-Remote": config.remote,
    "Client-Instance": config.dacp,
    ...extraHeaders
  }
  const lines = [
    `${method} ${path} ${protocol}`,
    `Host: ${config.host}:${config.port}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    `Content-Type: ${contentType}`,
    `Content-Length: ${body.byteLength}`,
    "",
    ""
  ]
  const head = new TextEncoder().encode(lines.join("\r\n"))
  const msg = new Uint8Array(head.byteLength + body.byteLength)
  msg.set(head)
  msg.set(body, head.byteLength)
  return msg
}

export const make = (
  host: string,
  port: number,
  dacp: string,
  remote: string
): Effect.Effect<HapHttpClient> =>
  Effect.gen(function* () {
    const config: Config = { host, port, dacp, remote }
    const stateRef = yield* Ref.make<State>({
      socket: Option.none(),
      session: Option.none(),
      readTimeoutMs: 8000,
      incoming: new Uint8Array(),
      waiters: []
    })

    const notifyWaiters = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      for (const waiter of state.waiters) {
        yield* Deferred.succeed(waiter, undefined)
      }
      yield* Ref.update(stateRef, (s) => ({ ...s, waiters: [] }))
    })

    const ensureSocket = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      if (Option.isSome(state.socket) && !state.socket.value.destroyed) {
        return state.socket.value
      }

      const socketDeferred = yield* Deferred.make<Net.Socket, PlatformError>()
      const sock = Net.connect({ host, port }, () => {
        Effect.runSync(Deferred.succeed(socketDeferred, sock))
      })

      sock.on("data", (chunk: Buffer) => {
        Effect.runSync(
          Effect.gen(function* () {
            yield* Ref.update(stateRef, (st) => {
              const newIncoming = new Uint8Array(st.incoming.length + chunk.length)
              newIncoming.set(st.incoming)
              newIncoming.set(chunk, st.incoming.length)
              return { ...st, incoming: newIncoming }
            })
            yield* notifyWaiters
          })
        )
      })

      sock.on("error", (err: Error) => {
        Effect.runSync(
          Deferred.fail(
            socketDeferred,
            systemError({
              _tag: "Unknown",
              module: "Socket",
              method: "connect",
              pathOrDescriptor: `${host}:${port}`,
              description: err.message
            })
          )
        )
      })

      const socket = yield* Deferred.await(socketDeferred)
      yield* Ref.update(stateRef, (s) => ({ ...s, socket: Option.some(socket) }))
      return socket
    })

    const waitForMore = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef)
      const waiter = yield* Deferred.make<void, never>()
      yield* Ref.update(stateRef, (s) => ({ ...s, waiters: [...s.waiters, waiter] }))
      
      yield* Effect.matchEffect(Effect.timeout(Deferred.await(waiter), state.readTimeoutMs), {
        onFailure: () =>
          Effect.fail(
            systemError({
              _tag: "TimedOut",
              module: "Socket",
              method: "read",
              pathOrDescriptor: "socket",
              description: "AirPlay HTTP read timed out"
            })
          ),
        onSuccess: () => Effect.void
      })
    })

    const readPlainHttp = Effect.gen(function* () {
      while (true) {
        const state = yield* Ref.get(stateRef)
        const parsed = tryParseHttp(state.incoming)
        if (Option.isSome(parsed)) {
          yield* Ref.update(stateRef, (s) => ({ ...s, incoming: s.incoming.slice(parsed.value.consumed) }))
          return { status: parsed.value.status, body: parsed.value.body }
        }
        yield* waitForMore
      }
    })

    const readEncryptedHttp = (sess: Encrypted.EncryptedSession) =>
      Effect.gen(function* () {
        let decrypted = new Uint8Array()
        while (true) {
          const state = yield* Ref.get(stateRef)
          const step = yield* Encrypted.decryptAvailable(sess, state.incoming)
          if (step.plaintext.byteLength > 0) {
            const next = new Uint8Array(decrypted.byteLength + step.plaintext.byteLength)
            next.set(decrypted)
            next.set(step.plaintext, decrypted.byteLength)
            decrypted = next
          }

          const parsed = tryParseHttp(decrypted)
          if (Option.isSome(parsed)) {
            yield* Ref.update(stateRef, (s) => ({ ...s, incoming: step.rest }))
            return { status: parsed.value.status, body: parsed.value.body }
          }

          if (step.rest.byteLength === state.incoming.byteLength) {
            yield* waitForMore
          } else {
            yield* Ref.update(stateRef, (s) => ({ ...s, incoming: step.rest }))
          }
        }
      })

    const request = (
      method: string,
      path: string,
      body: Uint8Array,
      contentType: string,
      extraHeaders?: Record<string, string>,
      protocol?: string
    ): Effect.Effect<{ status: number; body: Uint8Array }, PlatformError | Suite.ForgedFrame, Encrypted.Suite> =>
      Effect.gen(function* () {
        const socket = yield* ensureSocket
        const msg = encodeRequest(config, method, path, body, contentType, extraHeaders ?? {}, protocol ?? "HTTP/1.1")

        const state = yield* Ref.get(stateRef)
        const wire = Option.isSome(state.session)
          ? yield* Encrypted.encryptMessage(Option.getOrThrow(state.session), msg)
          : msg

        yield* Effect.callback<void, PlatformError>((resume) => {
          socket.write(new Uint8Array(wire), (err) => {
            if (err !== null && err !== undefined) {
              resume(
                Effect.fail(
                  systemError({
                    _tag: "Unknown",
                    module: "Socket",
                    method: "write",
                    pathOrDescriptor: "socket",
                    description: err.message
                  })
                )
              )
            } else {
              resume(Effect.void)
            }
          })
        })

        return yield* (Option.isSome(state.session)
          ? readEncryptedHttp(Option.getOrThrow(state.session))
          : readPlainHttp)
      })

    return {
      get: (path) => request("GET", path, new Uint8Array(), "application/octet-stream"),
      post: (path, body, contentType, extraHeaders) =>
        request("POST", path, body, contentType ?? "application/octet-stream", extraHeaders),
      exchange: (method, path, body, contentType, extraHeaders, protocol) =>
        request(method, path, body, contentType, extraHeaders, protocol),
      enableEncryption: (session) => Ref.update(stateRef, (s) => ({ ...s, session: Option.some(session) })),
      setReadTimeout: (ms) => Ref.update(stateRef, (s) => ({ ...s, readTimeoutMs: ms })),
      close: () =>
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef)
          if (Option.isSome(state.socket)) {
            state.socket.value.destroy()
          }
          yield* Ref.update(stateRef, (s) => ({ ...s, socket: Option.none() }))
        })
    }
  })
