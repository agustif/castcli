// Keep-alive HAP HTTP client using @effect/platform Socket.
//
// After pair-verify M4, HTTP is HAP-framed (2-byte LE length + ChaCha20-Poly1305).
//
// NodeSocket.run fans each TCP chunk onto a FiberSet. A failing parse fiber
// completes that set and tears the socket down, which is what "An error
// occurred during Read" was on the second AirPlay request. Chunks go onto a
// Queue; one drain fiber parses them in order.

import { Effect, Ref, Option, Deferred, Scope, Queue, Duration, Array } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { makeNet } from "@effect/platform-node-shared/NodeSocket"
import * as Airplay from "@castcli/airplay"

interface Config {
  readonly host: string
  readonly port: number
  readonly dacp: string
  readonly remote: string
  readonly hkpVersion: number
}

interface HttpResponse {
  readonly status: number
  readonly body: Uint8Array
}

interface State {
  session: Option.Option<Airplay.EncryptedSession.EncryptedSession>
  readTimeoutMs: number
  buffer: Uint8Array
  decryptedPlaintext: Uint8Array
  hkpVersion: number
}

const empty = new Uint8Array()

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.length === 0) return right
  if (right.length === 0) return left
  const out = new Uint8Array(left.length + right.length)
  out.set(left)
  out.set(right, left.length)
  return out
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
    "X-Apple-HKP": String(config.hkpVersion),
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

const readError = (cause: unknown): Socket.SocketError =>
  new Socket.SocketError({
    reason: new Socket.SocketReadError({ cause })
  })

export const make = (
  host: string,
  port: number,
  dacp: string,
  remote: string,
  hkpVersion?: number
): Effect.Effect<
  {
    get: (path: string) => Effect.Effect<HttpResponse, Socket.SocketError, Airplay.Suite.Suite>
    post: (
      path: string,
      body: Uint8Array,
      contentType?: string,
      extraHeaders?: Record<string, string>
    ) => Effect.Effect<HttpResponse, Socket.SocketError, Airplay.Suite.Suite>
    exchange: (
      method: string,
      path: string,
      body: Uint8Array,
      contentType: string,
      extraHeaders?: Record<string, string>,
      protocol?: string
    ) => Effect.Effect<HttpResponse, Socket.SocketError, Airplay.Suite.Suite>
    enableEncryption: (session: Airplay.EncryptedSession.EncryptedSession) => Effect.Effect<void>
    setReadTimeout: (ms: number) => Effect.Effect<void>
    setHkpVersion: (version: number) => Effect.Effect<void>
  },
  Socket.SocketError,
  Scope.Scope | Airplay.Suite.Suite
> =>
  Effect.gen(function* () {
    const config: Config = { host, port, dacp, remote, hkpVersion: hkpVersion ?? 3 }
    const socket = yield* makeNet({ host, port })
    const stateRef = yield* Ref.make<State>({
      session: Option.none(),
      readTimeoutMs: 8000,
      buffer: empty,
      decryptedPlaintext: empty,
      hkpVersion: config.hkpVersion
    })
    const waiters = yield* Ref.make<
      ReadonlyArray<Deferred.Deferred<HttpResponse, Socket.SocketError>>
    >([])
    const ready = yield* Ref.make<ReadonlyArray<HttpResponse>>([])
    const chunks = yield* Queue.unbounded<Uint8Array>()
    const writer = yield* socket.writer
    const suiteService = yield* Airplay.Suite.Suite

    const failWaiters = (error: Socket.SocketError) =>
      Effect.gen(function* () {
        const pending = yield* Ref.getAndSet(waiters, [])
        yield* Effect.forEach(pending, (deferred) => Deferred.fail(deferred, error), {
          discard: true
        })
      })

    const takeWaiter = () =>
      Ref.modify(waiters, (list) => {
        const head = Array.get(list, 0)
        return [head, Option.isSome(head) ? list.slice(1) : list] as const
      })

    const enqueueReady = (response: HttpResponse) =>
      Ref.update(ready, (list) => [...list, response])

    const takeReady = () =>
      Ref.modify(ready, (list) => {
        const head = Array.get(list, 0)
        return [head, Option.isSome(head) ? list.slice(1) : list] as const
      })

    const deliver = (response: HttpResponse) =>
      Effect.gen(function* () {
        const waiter = yield* takeWaiter()
        if (Option.isSome(waiter)) {
          yield* Deferred.succeed(waiter.value, response)
          return
        }
        yield* enqueueReady(response)
      })

    const decryptStep = (
      session: Airplay.EncryptedSession.EncryptedSession,
      buffer: Uint8Array
    ) =>
      Airplay.EncryptedSession.decryptAvailable(session, buffer).pipe(
        Effect.provideService(Airplay.Suite.Suite, suiteService),
        Effect.mapError((err) => readError(err))
      )

    const drainPlaintext = (): Effect.Effect<void, Socket.SocketError> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        const parsed = tryParseHttp(state.decryptedPlaintext)
        if (Option.isNone(parsed)) return
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          decryptedPlaintext: s.decryptedPlaintext.slice(parsed.value.consumed)
        }))
        yield* deliver({ status: parsed.value.status, body: parsed.value.body })
        yield* drainPlaintext()
      })

    const drainBuffer = (): Effect.Effect<void, Socket.SocketError> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        if (Option.isSome(state.session)) {
          const step = yield* decryptStep(Option.getOrThrow(state.session), state.buffer)
          yield* Ref.update(stateRef, (s) => ({
            ...s,
            buffer: step.rest,
            decryptedPlaintext: concatBytes(s.decryptedPlaintext, step.plaintext)
          }))
          yield* drainPlaintext()
          return
        }
        const parsed = tryParseHttp(state.buffer)
        if (Option.isNone(parsed)) return
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          buffer: s.buffer.slice(parsed.value.consumed)
        }))
        yield* deliver({ status: parsed.value.status, body: parsed.value.body })
        yield* drainBuffer()
      })

    const onChunk = (chunk: Uint8Array) =>
      Effect.gen(function* () {
        yield* Ref.update(stateRef, (s) => ({ ...s, buffer: concatBytes(s.buffer, chunk) }))
        yield* drainBuffer()
      })

    yield* Effect.forkScoped(
      socket.run((chunk: Uint8Array) => {
        Queue.offerUnsafe(chunks, chunk)
      }).pipe(
        Effect.catchCause((cause) => failWaiters(readError(cause)))
      )
    )

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const chunk = yield* Queue.take(chunks)
          yield* onChunk(chunk).pipe(
            Effect.catchCause((cause) => failWaiters(readError(cause)))
          )
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
    ): Effect.Effect<HttpResponse, Socket.SocketError, Airplay.Suite.Suite> =>
      Effect.gen(function* () {
        yield* drainBuffer()
        const cached = yield* takeReady()
        if (Option.isSome(cached)) return cached.value

        const state = yield* Ref.get(stateRef)
        const currentConfig = { ...config, hkpVersion: state.hkpVersion }
        const msg = encodeRequest(
          currentConfig,
          method,
          path,
          body,
          contentType,
          extraHeaders ?? {},
          protocol ?? "HTTP/1.1"
        )
        const wire = Option.isSome(state.session)
          ? yield* Airplay.EncryptedSession.encryptMessage(Option.getOrThrow(state.session), msg).pipe(
              Effect.mapError((err) =>
                new Socket.SocketError({
                  reason: new Socket.SocketWriteError({ cause: err })
                })
              )
            )
          : msg

        const responseDeferred = yield* Deferred.make<HttpResponse, Socket.SocketError>()
        yield* Ref.update(waiters, (list) => [...list, responseDeferred])

        yield* writer(wire)
        const response = yield* Deferred.await(responseDeferred).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(state.readTimeoutMs),
            orElse: () => Effect.fail(readError(new Error(`AirPlay HTTP read timed out on ${method} ${path}`)))
          })
        )
        yield* Effect.logDebug(
          `hap ${method} ${path} Host ${config.host}:${config.port} wrote ${wire.byteLength}B -> HTTP ${response.status} ${response.body.byteLength}B`
        )
        return response
      })

    return {
      get: (path) => request("GET", path, empty, "application/octet-stream"),
      post: (path, body, contentType, extraHeaders) =>
        request("POST", path, body, contentType ?? "application/octet-stream", extraHeaders),
      exchange: (method, path, body, contentType, extraHeaders, protocol) =>
        request(method, path, body, contentType, extraHeaders, protocol),
      enableEncryption: (session) => Ref.update(stateRef, (s) => ({ ...s, session: Option.some(session) })),
      setReadTimeout: (ms) => Ref.update(stateRef, (s) => ({ ...s, readTimeoutMs: ms })),
      setHkpVersion: (version) => Ref.update(stateRef, (s) => ({ ...s, hkpVersion: version }))
    }
  })
