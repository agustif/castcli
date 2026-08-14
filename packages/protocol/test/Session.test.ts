// The session, exercised without a television.
//
// Everything interesting here is a function of the bytes exchanged: virtual
// connections have to be opened before a receiver listens at all, request ids
// have to advance, and a transport id only exists once the receiver has
// reported one. None of that needed a TLS socket to test — it needed the socket
// to be a value, which is why `makeOver` exists.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Queue, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { CastMessage } from "../src/Frame.ts"
import { Payload } from "../src/Frame.ts"
import * as Ns from "../src/Namespace.ts"
import { makeOver, MediaCommand } from "../src/Session.ts"
import { ConnectionLostError } from "@castcli/domain"

/**
 * What the fake receiver was told, in order. The payload is decoded rather than
 * cast: these tests assert on wire shapes, so reading them through a schema is
 * the same discipline the production code follows.
 */
const SentPayload = Schema.Record(Schema.String, Schema.Unknown)

const decodePayload = Schema.decodeEffect(Schema.fromJsonString(SentPayload))

interface Sent {
  readonly namespace: string
  readonly destinationId: string
  readonly payload: { readonly [key: string]: unknown }
}

/**
 * A socket that records what was sent and lets a test push replies back, so a
 * test can play the receiver's part: stay silent, answer late, or answer with
 * something unexpected.
 */
const fakeSocket = Effect.gen(function*() {
  const sent = yield* Ref.make<ReadonlyArray<Sent>>([])
  const inbound = yield* Queue.unbounded<CastMessage>()

  const socket = {
    send: (message: CastMessage) =>
      Effect.flatMap(
        Payload.$match(message.payload, {
          Text: ({ value }) =>
            // A payload this fake cannot read is recorded as empty rather than
            // failing the send: the assertion that follows should be what
            // reports the problem, with the message it was looking at.
            decodePayload(value).pipe(Effect.orElseSucceed(() => ({}))),
          Binary: () => Effect.succeed({})
        }),
        (payload) =>
          Ref.update(sent, (all) => [
            ...all,
            { namespace: message.namespace, destinationId: message.destinationId, payload }
          ])
      ),
    messages: Stream.fromQueue(inbound)
  }

  const receive = (namespace: string, payload: unknown) =>
    Queue.offer(inbound, {
      sourceId: "receiver-0",
      destinationId: "sender-0",
      namespace,
      payload: Payload.Text({ value: JSON.stringify(payload) })
    })

  return { socket, sent: Ref.get(sent), receive } as const
})

/** A MEDIA_STATUS, which is what gives a session something to command. */
const mediaStatus = (playerState: string) => ({
  type: "MEDIA_STATUS",
  status: [{ mediaSessionId: 3, playerState, currentTime: 12.5 }]
})

/** A RECEIVER_STATUS naming a running media app, as a real receiver sends it. */
const receiverStatus = (transportId: string) => ({
  type: "RECEIVER_STATUS",
  status: {
    applications: [
      { appId: "CC1AD845", sessionId: "session-1", transportId, statusText: "Ready to cast" }
    ]
  }
})

describe("Session", () => {
  it.effect("opens a virtual connection before saying anything else", () =>
    Effect.gen(function*() {
      const fake = yield* fakeSocket
      yield* makeOver(fake.socket)

      // The receiver ignores a sender that has not connected, which is a silent
      // failure rather than an error — worth pinning.
      const messages = yield* fake.sent
      assert.deepStrictEqual(
        messages.map((message) => message.namespace),
        [Ns.Connection]
      )
      assert.deepStrictEqual(messages[0]?.payload["type"], "CONNECT")
    }).pipe(Effect.scoped))

  it.effect("learns the transport id from a receiver status, then joins", () =>
    Effect.gen(function*() {
      const fake = yield* fakeSocket
      const session = yield* makeOver(fake.socket)

      const joining = yield* Effect.forkScoped(session.join)
      // The receiver answers only after being asked, so the reply has to come
      // after the GET_STATUS is on the wire.
      yield* TestClock.adjust("300 millis")
      yield* fake.receive(Ns.Receiver, receiverStatus("transport-7"))
      yield* TestClock.adjust("300 millis")
      yield* Fiber.join(joining)

      const messages = yield* fake.sent
      // A virtual connection to the *media transport*, which is a different
      // destination from the receiver and is what makes media commands work.
      assert.isTrue(
        messages.some((message) =>
          message.namespace === Ns.Connection && message.destinationId === "transport-7"
        )
      )
    }).pipe(Effect.scoped))

  it.effect("gives up joining when no session is running", () =>
    Effect.gen(function*() {
      const fake = yield* fakeSocket
      const session = yield* makeOver(fake.socket)

      // Silence is what an idle device does. The failure has to arrive on its
      // own rather than hanging, which is the bug this whole area had.
      const joining = yield* Effect.forkScoped(Effect.exit(session.join))
      yield* TestClock.adjust("10 seconds")
      const exit = yield* Fiber.join(joining)

      assert.isTrue(exit._tag === "Failure")
    }).pipe(Effect.scoped))

  it.effect("addresses media commands to the transport, with rising request ids", () =>
    Effect.gen(function*() {
      const fake = yield* fakeSocket
      const session = yield* makeOver(fake.socket)

      const joining = yield* Effect.forkScoped(session.join)
      yield* TestClock.adjust("300 millis")
      yield* fake.receive(Ns.Receiver, receiverStatus("transport-7"))
      yield* TestClock.adjust("300 millis")
      yield* Fiber.join(joining)
      // A receiver announces its media session unprompted once the transport
      // connection is open; without one there is nothing to command.
      yield* fake.receive(Ns.Media, mediaStatus("PLAYING"))
      yield* TestClock.adjust("100 millis")

      yield* session.mediaCommand(MediaCommand.PAUSE())
      yield* session.mediaCommand(MediaCommand.PLAY())

      // Joining itself asks for a media status, so the commands are what
      // follows it.
      const media = (yield* fake.sent).filter((message) =>
        message.namespace === Ns.Media && message.payload["type"] !== "GET_STATUS"
      )
      assert.deepStrictEqual(media.map((message) => message.payload["type"]), ["PAUSE", "PLAY"])
      assert.deepStrictEqual(
        media.map((message) => message.destinationId),
        ["transport-7", "transport-7"]
      )

      // Ids must differ: a receiver correlates its replies by request id, and
      // reusing one makes two answers indistinguishable.
      const ids = media.map((message) => message.payload["requestId"])
      assert.notStrictEqual(ids[0], ids[1])
    }).pipe(Effect.scoped))

  it.effect("carries the seek position on the wire", () =>
    Effect.gen(function*() {
      const fake = yield* fakeSocket
      const session = yield* makeOver(fake.socket)

      const joining = yield* Effect.forkScoped(session.join)
      yield* TestClock.adjust("300 millis")
      yield* fake.receive(Ns.Receiver, receiverStatus("transport-7"))
      yield* TestClock.adjust("300 millis")
      yield* Fiber.join(joining)
      yield* fake.receive(Ns.Media, mediaStatus("PLAYING"))
      yield* TestClock.adjust("100 millis")

      yield* session.mediaCommand(MediaCommand.SEEK({ currentTime: 346.25 }))

      const seek = (yield* fake.sent).findLast((message) => message.namespace === Ns.Media)
      assert.deepStrictEqual(seek?.payload["type"], "SEEK")
      assert.deepStrictEqual(seek?.payload["currentTime"], 346.25)
    }).pipe(Effect.scoped))

  it.effect("reports player status from the media namespace", () =>
    Effect.gen(function*() {
      const fake = yield* fakeSocket
      const session = yield* makeOver(fake.socket)

      const listening = yield* Effect.forkScoped(Stream.runHead(session.statuses))
      yield* TestClock.adjust("100 millis")
      yield* fake.receive(Ns.Media, {
        type: "MEDIA_STATUS",
        status: [{ mediaSessionId: 3, playerState: "PLAYING", currentTime: 12.5 }]
      })
      yield* TestClock.adjust("100 millis")

      const status = yield* Fiber.join(listening)
      assert.deepStrictEqual(
        Option.map(status, (playing) => playing.playerState),
        Option.some("PLAYING")
      )
      assert.deepStrictEqual(
        Option.map(status, (playing) => playing.currentTimeSeconds),
        Option.some(12.5)
      )
    }).pipe(Effect.scoped))

  it.effect("refuses a media command when nothing is playing", () =>
    Effect.gen(function*() {
      const fake = yield* fakeSocket
      const session = yield* makeOver(fake.socket)

      const joining = yield* Effect.forkScoped(session.join)
      yield* TestClock.adjust("300 millis")
      yield* fake.receive(Ns.Receiver, receiverStatus("transport-7"))
      yield* TestClock.adjust("300 millis")
      yield* Fiber.join(joining)

      // No MEDIA_STATUS, so there is no media session. This used to succeed
      // while sending nothing, which is how `cast pause` could print "paused"
      // at a device that never heard it.
      const exit = yield* Effect.exit(session.mediaCommand(MediaCommand.PAUSE()))
      assert.isTrue(exit._tag === "Failure")

      const media = (yield* fake.sent).filter((message) => message.namespace === Ns.Media)
      assert.deepStrictEqual(media.map((message) => message.payload["type"]), ["GET_STATUS"])
    }).pipe(Effect.scoped))

  it.effect("reports a lost connection through the statuses stream", () =>
    Effect.gen(function*() {
      // A device that goes away does not say goodbye. The socket notices the
      // silence and fails; the session has to pass that on, because the caller
      // is watching statuses and nothing else. Forking the pump and forgetting
      // its result is how a dead connection stayed invisible — the fiber died
      // and the stream simply never produced again, which looks exactly like a
      // film playing quietly.
      const session = yield* makeOver({
        send: () => Effect.void,
        messages: Stream.fail(new ConnectionLostError())
      })

      const exit = yield* Effect.exit(Stream.runHead(session.statuses))

      assert.isTrue(exit._tag === "Failure", "a dead connection produced no failure")
    }).pipe(Effect.scoped))
})
