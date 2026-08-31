// Keep-alive HAP HTTP client using @effect/platform Socket.
//
// After pair-verify M4, HTTP is HAP-framed (2-byte LE length + ChaCha20-Poly1305).

import { Effect, Ref, Option, Deferred, Scope } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { makeNet } from "@effect/platform-node-shared/NodeSocket"
import * as Airplay from "@castcli/airplay"

interface Config {
  readonly host: string
  readonly port: number
  readonly dacp: string
  readonly remote: string
}

interface State {
  session: Option.Option<Airplay.EncryptedSession.EncryptedSession>
  readTimeoutMs: number
  buffer: Uint8Array
  pendingResponse: Option.Option<Deferred.Deferred<{ status: number; body: Uint8Array }, Socket.SocketError>>
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

const tryCompleteResponse = (
  stateRef: Ref.Ref<State>,
  suiteService: Airplay.Suite.Suite
): Effect.Effect<boolean, Socket.SocketError> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(stateRef)
    const isEncrypted = Option.isSome(state.session)

    let plaintext = state.buffer
    if (isEncrypted) {
      const sess = Option.getOrThrow(state.session)
      const step = yield* Airplay.EncryptedSession.decryptAvailable(sess, state.buffer).pipe(
        Effect.provideService(Airplay.Suite.Suite, suiteService),
        Effect.mapError(
          (err) =>
            new Socket.SocketError({
              reason: new Socket.SocketReadError({
                cause: err
              })
            })
        )
      )
      plaintext = step.plaintext
      yield* Ref.update(stateRef, (s) => ({ ...s, buffer: step.rest }))
    }

    const parsed = tryParseHttp(plaintext)
    if (Option.isSome(parsed)) {
      if (!isEncrypted) {
        yield* Ref.update(stateRef, (s) => ({ ...s, buffer: s.buffer.slice(parsed.value.consumed) }))
      }
      if (Option.isSome(state.pendingResponse)) {
        yield* Deferred.succeed(Option.getOrThrow(state.pendingResponse), {
          status: parsed.value.status,
          body: parsed.value.body
        })
        yield* Ref.update(stateRef, (s) => ({ ...s, pendingResponse: Option.none() }))
      }
      return true
    }
    return false
  })

export const make = (
  host: string,
  port: number,
  dacp: string,
  remote: string
): Effect.Effect<
  {
    get: (path: string) => Effect.Effect<{ status: number; body: Uint8Array }, Socket.SocketError, Airplay.Suite.Suite>
    post: (
      path: string,
      body: Uint8Array,
      contentType?: string,
      extraHeaders?: Record<string, string>
    ) => Effect.Effect<{ status: number; body: Uint8Array }, Socket.SocketError, Airplay.Suite.Suite>
    exchange: (
      method: string,
      path: string,
      body: Uint8Array,
      contentType: string,
      extraHeaders?: Record<string, string>,
      protocol?: string
    ) => Effect.Effect<{ status: number; body: Uint8Array }, Socket.SocketError, Airplay.Suite.Suite>
    enableEncryption: (session: Airplay.EncryptedSession.EncryptedSession) => Effect.Effect<void>
    setReadTimeout: (ms: number) => Effect.Effect<void>
  },
  Socket.SocketError,
  Scope.Scope | Airplay.Suite.Suite
> =>
  Effect.gen(function* () {
    const config: Config = { host, port, dacp, remote }
    const socket = yield* makeNet({ host, port })
    const stateRef = yield* Ref.make<State>({
      session: Option.none(),
      readTimeoutMs: 8000,
      buffer: new Uint8Array(),
      pendingResponse: Option.none()
    })

    const writer = yield* socket.writer
    const suiteService = yield* Airplay.Suite.Suite

    yield* Effect.forkScoped(
      socket.run((chunk: Uint8Array) =>
        Effect.gen(function* () {
          yield* Ref.update(stateRef, (s) => {
            const newBuffer = new Uint8Array(s.buffer.length + chunk.length)
            newBuffer.set(s.buffer)
            newBuffer.set(chunk, s.buffer.length)
            return { ...s, buffer: newBuffer }
          })
          yield* Effect.matchEffect(tryCompleteResponse(stateRef, suiteService), {
            onFailure: () => Effect.void,
            onSuccess: () => Effect.void
          })
        })
      )
    )

    const request = (
      method: string,
      path: string,
      body: Uint8Array,
      contentType: string,
      extraHeaders?: Record<string, string>,
      protocol?: string
    ): Effect.Effect<{ status: number; body: Uint8Array }, Socket.SocketError, Airplay.Suite.Suite> =>
      Effect.gen(function* () {
        const msg = encodeRequest(config, method, path, body, contentType, extraHeaders ?? {}, protocol ?? "HTTP/1.1")

        const state = yield* Ref.get(stateRef)
        const wire = Option.isSome(state.session)
          ? yield* Airplay.EncryptedSession.encryptMessage(Option.getOrThrow(state.session), msg).pipe(
              Effect.mapError(
                (err) =>
                  new Socket.SocketError({
                    reason: new Socket.SocketWriteError({ cause: err })
                  })
              )
            )
          : msg

        const responseDeferred = yield* Deferred.make<{ status: number; body: Uint8Array }, Socket.SocketError>()
        yield* Ref.update(stateRef, (s) => ({ ...s, pendingResponse: Option.some(responseDeferred) }))

        yield* writer(wire)

        return yield* Effect.matchEffect(Effect.timeout(Deferred.await(responseDeferred), state.readTimeoutMs), {
          onFailure: () =>
            Effect.fail(
              new Socket.SocketError({
                reason: new Socket.SocketReadError({
                  cause: new Error("AirPlay HTTP read timed out")
                })
              })
            ),
          onSuccess: (result) => Effect.succeed(result)
        })
      })

    return {
      get: (path) => request("GET", path, new Uint8Array(), "application/octet-stream"),
      post: (path, body, contentType, extraHeaders) =>
        request("POST", path, body, contentType ?? "application/octet-stream", extraHeaders),
      exchange: (method, path, body, contentType, extraHeaders, protocol) =>
        request(method, path, body, contentType, extraHeaders, protocol),
      enableEncryption: (session) => Ref.update(stateRef, (s) => ({ ...s, session: Option.some(session) })),
      setReadTimeout: (ms) => Ref.update(stateRef, (s) => ({ ...s, readTimeoutMs: ms }))
    }
  })
