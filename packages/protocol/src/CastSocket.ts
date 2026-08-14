// TLS transport for the Cast protocol, expressed as an Effect `Socket`.
//
// Effect v4 ships no TLS or raw-TCP *constructor*: `effect/unstable/socket`
// only builds sockets from WebSockets or from a web `TransformStream`. But the
// `Socket` abstraction itself is transport-agnostic, and Node's
// `Duplex.toWeb()` turns a TLS socket into exactly the `{ readable, writable }`
// pair that `Socket.fromTransformStream` wants.
//
// So the only Node-specific part is the handshake below; everything downstream
// consumes a real `Socket.Socket` and Effect's own combinators.

import { Cause, Duration, Effect, Exit, Queue, Ref, Stream } from "effect"
import { ConnectionLostError, DeviceUnreachableError } from "@castcli/domain"
import { Socket } from "effect/unstable/socket"
import { Duplex } from "node:stream"
import * as tls from "node:tls"
import { type CastMessage, encodeFrame, takeFrames } from "./Frame.ts"

export interface CastSocket {
  readonly send: (message: CastMessage) => Effect.Effect<void, Socket.SocketError>
  readonly messages: Stream.Stream<CastMessage, Socket.SocketError | ConnectionLostError>
}

/**
 * A device that is off, asleep or on another network accepts nothing and
 * answers nothing, so without this the CLI simply hangs — no message, no
 * failure. TCP's own timeout is minutes.
 */
const CONNECT_TIMEOUT_MS = 5_000

/**
 * How long silence is allowed to last before the connection counts as dead.
 *
 * A Cast receiver sends a heartbeat every five seconds, so three missed ones is
 * unambiguous while leaving room for a network that is merely slow.
 */
const SILENCE_LIMIT = Duration.seconds(15)

/**
 * Acquire a TLS connection and hand it over as a web transform stream. Cast
 * devices present a self-signed chain, so verification is disabled; the
 * connection is point-to-point on the local network.
 */
const acquireTls = (host: string, port: number) =>
  Effect.acquireRelease(
    Effect.callback<tls.TLSSocket, Socket.SocketError>((resume) => {
      const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        resume(Effect.succeed(socket))
      })
      socket.setNoDelay(true)
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
        socket.destroy()
        resume(
          Effect.fail(
            new Socket.SocketError({
              reason: new Socket.SocketOpenError({ kind: "Timeout", cause: undefined })
            })
          )
        )
      })
      socket.once("error", (cause) =>
        resume(
          Effect.fail(
            new Socket.SocketError({
              reason: new Socket.SocketOpenError({ kind: "Unknown", cause })
            })
          )
        ))
    }),
    (socket) => Effect.sync(() => socket.destroy())
  )

/**
 * Connect to a Cast device and expose it as framed protocol messages.
 *
 * Cast frames are length-prefixed and do not align with TCP reads, so the
 * partial tail of each read is carried forward in a `Ref` until it completes.
 */
export const connect = Effect.fn("CastSocket.connect")(function*(
  host: string,
  port: number
) {
  // Acquired eagerly rather than handed to `fromTransformStream` as a lazy
  // effect: a lazily-opened socket defers the connection to the first read or
  // write, so an unreachable device produced a write that never settled and a
  // command that hung with nothing printed. Yielding here means "device is off"
  // is a typed failure at the point of connecting.
  const tlsSocket = yield* acquireTls(host, port).pipe(
    Effect.catchTag(
      "SocketError",
      (cause) => Effect.fail(new DeviceUnreachableError({ ip: host, port, cause }))
    )
  )
  const socket = yield* Socket.fromTransformStream(
    Effect.sync(() => Duplex.toWeb(tlsSocket))
  )
  // The `Done` error channel lets the queue be ended when the socket closes,
  // which terminates the message stream instead of leaving it hanging. A socket
  // *failure* is a different thing and ends the queue with the cause, so that a
  // device which is off or unreachable surfaces as an error rather than as a
  // stream that politely produced nothing.
  const queue = yield* Queue.unbounded<
    CastMessage,
    Socket.SocketError | ConnectionLostError | Cause.Done
  >()
  const pending = yield* Ref.make<Buffer>(Buffer.alloc(0))

  yield* Effect.forkScoped(
    socket.run((chunk) =>
      Effect.gen(function*() {
        const buffered = Buffer.concat([yield* Ref.get(pending), Buffer.from(chunk)])
        const [messages, rest] = takeFrames(buffered)
        yield* Ref.set(pending, rest)
        yield* Effect.forEach(messages, (message) => Queue.offer(queue, message), {
          discard: true
        })
      })
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Queue.failCause(queue, exit.cause) : Queue.end(queue)
      )
    )
  )

  const write = yield* socket.writer

  return {
    send: (message: CastMessage) => write(encodeFrame(message)),
    // A device that goes away mid-film does not close the connection politely
    // — it stops existing, and on some paths nothing at either end notices.
    // Silence is the signal, which is what the heartbeat is for: a receiver
    // pings every few seconds, so a much longer gap means the far end is gone.
    //
    // Expressed on the stream rather than as a watchdog fiber holding a
    // timestamp: the condition *is* "this stream stopped producing", and
    // `timeoutOrElse` checks it on every pull for free.
    //
    // Without it the player sat with a dead socket indefinitely — measured at
    // over two minutes after the device had exited, with no error and no
    // attempt to reconnect.
    messages: Stream.fromQueue(queue).pipe(
      Stream.timeoutOrElse({
        duration: SILENCE_LIMIT,
        orElse: () => Stream.fail(new ConnectionLostError())
      })
    )
  } satisfies CastSocket
})
