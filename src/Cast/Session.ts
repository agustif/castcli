// Cast session orchestration: virtual connections, heartbeat, app launch, and
// media control.
//
// The protocol multiplexes several "virtual connections" over one TLS socket,
// each addressed by a destination id. You must CONNECT to a destination before
// it will accept anything, and the receiver drops you if heartbeats stop.

import { Effect, Match, Option, PubSub, Ref, Schedule, Stream } from "effect"
import { CastProtocolError, LoadFailedError } from "../Domain/Errors.ts"
import * as Ns from "./Protocol/Namespace.ts"
import * as Messages from "./Protocol/Messages.ts"
import * as CastSocket from "../Platform/CastSocket.ts"
import * as Frame from "./Protocol/Frame.ts"

const SENDER = Ns.SENDER_ID
const RECEIVER = Ns.RECEIVER_ID

/** Only text payloads carry JSON; the device-auth namespace sends binary. */
const payloadText = (message: Frame.CastMessage): string =>
  message.payload._tag === "Text" ? message.payload.value : ""

export interface PlayerStatus {
  readonly playerState: string
  readonly currentTimeSeconds: number
}

export interface Session {
  readonly launch: Effect.Effect<void, CastProtocolError>
  /**
   * The receiver refusing the media. It answers LOAD with LOAD_FAILED and then
   * says nothing further, so without watching for this a rejected stream looks
   * exactly like a stream that is merely slow to start.
   */
  readonly loadFailures: Stream.Stream<LoadFailedError>
  /** Attach to a running session rather than starting a new one. */
  readonly join: Effect.Effect<void, CastProtocolError>
  readonly load: (media: unknown, activeTrackIds: ReadonlyArray<number>) => Effect.Effect<void>
  readonly mediaCommand: (type: string, extra?: Record<string, unknown>) => Effect.Effect<void>
  readonly setVolume: (level: number) => Effect.Effect<void>
  readonly stopReceiver: Effect.Effect<void>
  readonly statuses: Stream.Stream<PlayerStatus>
}

export const make = Effect.fn("CastSession.make")(function*(host: string, port: number) {
  const socket = yield* CastSocket.connect(host, port)
  const requestId = yield* Ref.make(1)
  const transportId = yield* Ref.make<string | null>(null)
  const sessionId = yield* Ref.make<string | null>(null)
  const mediaSessionId = yield* Ref.make<number | null>(null)
  const connected = yield* Ref.make<ReadonlySet<string>>(new Set())

  const nextRequestId = Ref.getAndUpdate(requestId, (n) => n + 1)

  // A failed write is logged rather than discarded: silently dropping it was
  // how a dead control socket could look like a working one.
  const send = (destinationId: string, namespace: string, payload: unknown) =>
    socket.send({
      sourceId: SENDER,
      destinationId,
      namespace,
      payload: Frame.Payload.Text({ value: JSON.stringify(payload) })
    }).pipe(
      Effect.catch((cause) => Effect.logWarning(`cast send failed on ${namespace}: ${cause}`))
    )

  /** Open a virtual connection once per destination; the receiver ignores you otherwise. */
  const openConnection = Effect.fn("CastSession.openConnection")(function*(destination: string) {
    const already = yield* Ref.get(connected)
    yield* Effect.when(
      Effect.andThen(
        Ref.set(connected, new Set([...already, destination])),
        send(destination, Ns.Connection, { type: "CONNECT" })
      ),
      Effect.succeed(!already.has(destination))
    )
  })

  yield* openConnection(RECEIVER)

  // Decode every inbound frame through Schema — the payload arrives as a JSON
  // string, so `fromJsonString` handles parsing and validation in one step and
  // a malformed frame degrades to None instead of throwing.
  const decodeEnvelope = Messages.decodeEnvelope
  const decodeReceiver = Messages.decodeReceiverStatus
  const decodeMedia = Messages.decodeMediaStatus
  // Statuses are published, not polled. Polling the receiver for them at 1Hz
  // re-triggers its on-screen media overlay and pins it over the video, and
  // polling a Ref locally just burns a fiber to observe nothing.
  const statuses = yield* PubSub.unbounded<PlayerStatus>()
  const loadFailures = yield* PubSub.unbounded<LoadFailedError>()

  /** Answer heartbeats, or the receiver hangs up on us. */
  const onPing = (message: { readonly sourceId: string }) =>
    send(message.sourceId, Ns.Heartbeat, { type: "PONG" })

  const onReceiverStatus = (payload: string) =>
    Option.match(decodeReceiver(payload), {
      onNone: () => Effect.void,
      onSome: (status) =>
        Effect.gen(function*() {
          const app = status.status?.applications?.find(
            (candidate) => candidate.appId === Ns.DEFAULT_MEDIA_RECEIVER
          )
          yield* Option.match(Option.fromNullishOr(app?.transportId), {
            onNone: () => Effect.void,
            onSome: (value) => Ref.set(transportId, value)
          })
          yield* Option.match(Option.fromNullishOr(app?.sessionId), {
            onNone: () => Effect.void,
            onSome: (value) => Ref.set(sessionId, value)
          })
        })
    })

  const onMediaStatus = (payload: string) =>
    Option.match(decodeMedia(payload), {
      onNone: () => Effect.void,
      onSome: (message) =>
        Effect.gen(function*() {
          yield* Option.match(Option.fromNullishOr(message.status?.[0]), {
            onNone: () => Effect.void,
            onSome: (status) =>
              Effect.gen(function*() {
                yield* Option.match(Option.fromNullishOr(status.mediaSessionId), {
                  onNone: () => Effect.void,
                  onSome: (id) => Ref.set(mediaSessionId, id)
                })
                yield* PubSub.publish(statuses, {
                  playerState: status.playerState ?? "IDLE",
                  currentTimeSeconds: status.currentTime ?? 0
                })
              })
          })
        })
    })

  const onLoadFailed = (payload: string) =>
    PubSub.publish(loadFailures, new LoadFailedError({ detail: payload }))

  // Route by the payload's `type` discriminator. Match keeps the dispatch table
  // flat and total instead of a ladder of string comparisons.
  const route = (message: Frame.CastMessage) =>
    // Binary payloads belong to the device-auth namespace, which we do not
    // speak; there is no JSON to route.
    Option.match(
      message.payload._tag === "Text"
        ? decodeEnvelope(message.payload.value)
        : Option.none(),
      {
      onNone: () => Effect.void,
      onSome: (envelope) =>
        Match.value(envelope.type).pipe(
          Match.when("PING", () => onPing(message)),
          Match.when(
            "RECEIVER_STATUS",
            () => onReceiverStatus(message.payload._tag === "Text" ? message.payload.value : "")
          ),
          Match.when(
            "MEDIA_STATUS",
            () => onMediaStatus(message.payload._tag === "Text" ? message.payload.value : "")
          ),
          Match.when("LOAD_FAILED", () => onLoadFailed(payloadText(message))),
          Match.when("LOAD_CANCELLED", () => onLoadFailed(payloadText(message))),
          Match.orElse(() => Effect.void)
        )
    })

  const pump = socket.messages.pipe(Stream.mapEffect(route), Stream.runDrain)

  yield* Effect.forkScoped(pump)

  // Heartbeat. Effect.repeat on a Schedule rather than setInterval, so it is
  // interruptible with the scope and testable with TestClock.
  yield* Effect.forkScoped(
    Effect.repeat(
      send(RECEIVER, Ns.Heartbeat, { type: "PING" }),
      Schedule.spaced("5 seconds")
    )
  )

  const launch = Effect.gen(function*() {
    const id = yield* nextRequestId
    yield* send(RECEIVER, Ns.Receiver, {
      type: "LAUNCH",
      appId: Ns.DEFAULT_MEDIA_RECEIVER,
      requestId: id
    })
    // Wait for the receiver to report a transport for the media app. Polling
    // via retry keeps the timeout and the backoff in the Effect, rather than in
    // an ad-hoc promise race.
    const transport = yield* Ref.get(transportId).pipe(
      Effect.flatMap((value) =>
        value === null
          ? Effect.fail(new CastProtocolError({ message: "receiver app not up yet" }))
          : Effect.succeed(value)
      ),
      Effect.retry(Schedule.spaced("250 millis")),
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(
            new CastProtocolError({
              message: "timed out waiting for the receiver app to launch"
            })
          )
      })
    )
    yield* openConnection(transport)
  })

  const withTransport = <A>(f: (transport: string) => Effect.Effect<A>) =>
    Effect.flatMap(Ref.get(transportId), (transport) =>
      transport === null ? Effect.void : Effect.asVoid(f(transport)))

  /**
   * Attach to a session that is already running, without relaunching it — what
   * a control command wants, so that pausing does not restart the film.
   */
  const join = Effect.gen(function*() {
    const id = yield* nextRequestId
    yield* send(RECEIVER, Ns.Receiver, { type: "GET_STATUS", requestId: id })
    const transport = yield* Ref.get(transportId).pipe(
      Effect.flatMap((value) =>
        value === null
          ? Effect.fail(new CastProtocolError({ message: "no session is running on that device" }))
          : Effect.succeed(value)
      ),
      Effect.retry(Schedule.spaced("250 millis")),
      Effect.timeoutOrElse({
        duration: "8 seconds",
        orElse: () =>
          Effect.fail(new CastProtocolError({ message: "no session is running on that device" }))
      })
    )
    yield* openConnection(transport)
    // Ask for media status too, so mediaSessionId is populated before any
    // command that needs it.
    const mediaId = yield* nextRequestId
    yield* send(transport, Ns.Media, { type: "GET_STATUS", requestId: mediaId })
  })

  const session: Session = {
    launch,
    join,

    load: (media, activeTrackIds) =>
      withTransport((transport) =>
        Effect.gen(function*() {
          const id = yield* nextRequestId
          const currentSession = yield* Ref.get(sessionId)
          yield* send(transport, Ns.Media, {
            type: "LOAD",
            requestId: id,
            sessionId: currentSession,
            media,
            autoplay: true,
            currentTime: 0,
            ...(activeTrackIds.length > 0 ? { activeTrackIds } : {})
          })
        })),

    mediaCommand: (type, extra = {}) =>
      withTransport((transport) =>
        Effect.gen(function*() {
          const media = yield* Ref.get(mediaSessionId)
          const id = yield* nextRequestId
          // Before the first MEDIA_STATUS there is no session to command.
          yield* Effect.when(
            send(transport, Ns.Media, { type, requestId: id, mediaSessionId: media, ...extra }),
            Effect.succeed(media !== null)
          )
        })),

    setVolume: (level) =>
      Effect.gen(function*() {
        const id = yield* nextRequestId
        yield* send(RECEIVER, Ns.Receiver, {
          type: "SET_VOLUME",
          requestId: id,
          volume: { level: Math.max(0, Math.min(1, level)) }
        })
      }),

    stopReceiver: Effect.gen(function*() {
      const current = yield* Ref.get(sessionId)
      const id = yield* nextRequestId
      yield* Effect.when(
        send(RECEIVER, Ns.Receiver, { type: "STOP", requestId: id, sessionId: current }),
        Effect.succeed(current !== null)
      )
    }),

    statuses: Stream.fromPubSub(statuses),
    loadFailures: Stream.fromPubSub(loadFailures)
  }

  return session
})

