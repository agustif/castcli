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

import { Cause, Effect, Queue, Ref, Stream } from "effect"
import { Socket } from "effect/unstable/socket"
import { Duplex } from "node:stream"
import * as tls from "node:tls"
import { type CastMessage, encodeFrame, takeFrames } from "../Cast/Protocol/Frame.ts"

export interface CastSocket {
  readonly send: (message: CastMessage) => Effect.Effect<void, Socket.SocketError>
  readonly messages: Stream.Stream<CastMessage>
}

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
  ).pipe(Effect.map((socket) => Duplex.toWeb(socket) as Socket.InputTransformStream))

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
  const socket = yield* Socket.fromTransformStream(acquireTls(host, port))
  // The `Done` error channel lets the queue be ended when the socket closes,
  // which terminates the message stream instead of leaving it hanging.
  const queue = yield* Queue.unbounded<CastMessage, Cause.Done>()
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
    ).pipe(Effect.ensuring(Queue.end(queue)))
  )

  const write = yield* socket.writer

  return {
    send: (message: CastMessage) => write(encodeFrame(message)),
    messages: Stream.fromQueue(queue)
  } satisfies CastSocket
})
