// Cast session orchestration: virtual connections, heartbeat, app launch, and
// media control.
//
// The protocol multiplexes several "virtual connections" over one TLS socket,
// each addressed by a destination id. You must CONNECT to a destination before
// it will accept anything, and the receiver drops you if heartbeats stop.

import {
  Data,
  Effect,
  Match,
  Option,
  PubSub,
  Ref,
  Schedule,
  Schema,
  Stream,
  Struct
} from "effect"
import {
  CastProtocolError,
  LoadFailedError,
  MediaSessionId,
  type Seconds,
  SessionId,
  type TrackId,
  TransportId,
  VolumeLevel
} from "@castcli/domain"
import * as MediaNs from "./Media.ts"
import * as Ns from "./Namespace.ts"
import * as Messages from "./Messages.ts"
import * as CastSocket from "./CastSocket.ts"
import * as Frame from "./Frame.ts"

const SENDER = Ns.SENDER_ID
const RECEIVER = Ns.RECEIVER_ID

/**
 * What may cross the wire.
 *
 * Narrower than `unknown`, which is what this was: the payload is about to go
 * through JSON.stringify, so a Date or a Map would silently become something
 * the receiver cannot read. `undefined` is permitted because stringify drops
 * those keys, which is how optional fields encode.
 */
type WireValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<WireValue>
  | { readonly [key: string]: WireValue }

type WirePayload = { readonly [key: string]: WireValue }

/**
 * A command for the media namespace, with whatever that particular command
 * carries. Previously this was a bare type string plus
 * `Record<string, unknown>`, so nothing related the two: `EDIT_TRACKS_INFO`
 * without `activeTrackIds` compiled perfectly and silently did nothing.
 */
export type MediaCommand = Data.TaggedEnum<{
  readonly PLAY: {}
  readonly PAUSE: {}
  readonly STOP: {}
  readonly GET_STATUS: {}
  readonly SEEK: { readonly currentTime: number }
  readonly EDIT_TRACKS_INFO: { readonly activeTrackIds: ReadonlyArray<TrackId> }
}>

export const MediaCommand = Data.taggedEnum<MediaCommand>()

/** Only text payloads carry JSON; the device-auth namespace sends binary. */
const payloadText = (message: Frame.CastMessage): string =>
  message.payload._tag === "Text" ? message.payload.value : ""

/**
 * Derived from the schema rather than restated, so the state can only ever be
 * one the receiver actually reports.
 */
export const PlayerStatus = Schema.Struct({
  playerState: Ns.PlayerState,
  currentTimeSeconds: Schema.Number
})
export type PlayerStatus = typeof PlayerStatus.Type

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
  readonly load: (
    media: MediaNs.MediaInformation,
    activeTrackIds: ReadonlyArray<TrackId>,
    /** Where to begin, for a presentation the receiver can seek within. */
    startAt: Option.Option<Seconds>
  ) => Effect.Effect<void, CastProtocolError>
  readonly mediaCommand: (command: MediaCommand) => Effect.Effect<void, CastProtocolError>
  readonly setVolume: (level: VolumeLevel) => Effect.Effect<void>
  readonly stopReceiver: Effect.Effect<void>
  readonly statuses: Stream.Stream<PlayerStatus>
}

/**
 * Build a session over a socket that already exists.
 *
 * Split out from `make` so the protocol can be exercised without a TV: every
 * interesting behaviour here — virtual connections, the request-id sequence,
 * how a receiver status becomes a transport id — is a function of the bytes
 * exchanged, and pinning it to a real TLS connection made it untestable.
 */
export const makeOver = Effect.fn("CastSession.makeOver")(function*(
  socket: CastSocket.CastSocket
) {
  const requestId = yield* Ref.make(1)
  // Option rather than null: "we have not been told yet" is a real state that
  // every read has to consider, and a sentinel makes it easy to forget.
  const transportId = yield* Ref.make(Option.none<TransportId>())
  const sessionId = yield* Ref.make(Option.none<SessionId>())
  const mediaSessionId = yield* Ref.make(Option.none<MediaSessionId>())
  const connected = yield* Ref.make<ReadonlySet<string>>(new Set())

  const nextRequestId = Ref.getAndUpdate(requestId, (n) => n + 1)

  // A failed write is logged rather than discarded: silently dropping it was
  // how a dead control socket could look like a working one.
  const send = (destinationId: string, namespace: Ns.Namespace, payload: WirePayload) =>
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
          // Both ids are decoded, not merely copied: an empty string here
          // would be accepted by the wire schema and then addressed to.
          yield* Ref.update(transportId, (current) =>
            Option.orElse(
              Option.flatMap(
                Option.fromNullishOr(app?.transportId),
                (value) => TransportId.makeOption(value)
              ),
              () => current
            ))
          yield* Ref.update(sessionId, (current) =>
            Option.orElse(
              Option.flatMap(
                Option.fromNullishOr(app?.sessionId),
                (value) => SessionId.makeOption(value)
              ),
              () => current
            ))
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
                yield* Ref.update(mediaSessionId, (current) =>
                  Option.orElse(
                    Option.flatMap(
                      Option.fromNullishOr(status.mediaSessionId),
                      (id) => MediaSessionId.makeOption(id)
                    ),
                    () => current
                  ))
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
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new CastProtocolError({ message: "receiver app not up yet" })),
        onSome: (value: TransportId) => Effect.succeed(value)
      })),
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

  const withTransport = <A, E>(
    f: (transport: TransportId) => Effect.Effect<A, E>
  ): Effect.Effect<void, E | CastProtocolError> =>
    Effect.flatMap(
      Ref.get(transportId),
      Option.match({
        // Before the receiver app is up there is nothing to address. This used
        // to return void, which meant a command sent too early vanished and the
        // caller reported success — `cast pause` printing "paused" at a device
        // that never heard it.
        onNone: (): Effect.Effect<void, E | CastProtocolError> =>
          Effect.fail(new CastProtocolError({ message: "not attached to a receiver session" })),
        onSome: (transport: TransportId): Effect.Effect<void, E | CastProtocolError> =>
          Effect.asVoid(f(transport))
      })
    )

  /**
   * Attach to a session that is already running, without relaunching it — what
   * a control command wants, so that pausing does not restart the film.
   */
  const join = Effect.gen(function*() {
    const id = yield* nextRequestId
    yield* send(RECEIVER, Ns.Receiver, { type: "GET_STATUS", requestId: id })
    const transport = yield* Ref.get(transportId).pipe(
      Effect.flatMap(Option.match({
        onNone: () =>
          Effect.fail(new CastProtocolError({ message: "no session is running on that device" })),
        onSome: (value: TransportId) => Effect.succeed(value)
      })),
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

    load: (media, activeTrackIds, startAt) =>
      withTransport((transport) =>
        Effect.gen(function*() {
          const id = yield* nextRequestId
          const currentSession = yield* Ref.get(sessionId)
          // Encoded through the schema rather than serialised as-is. A
          // Schema.Class instance is not JSON, and the difference only shows up
          // once the receiver rejects the payload.
          const request = yield* MediaNs.encodeLoad(
            new MediaNs.LoadRequest({
              type: "LOAD",
              requestId: id,
              media,
              autoplay: true,
              // Zero unless a start position was given. Only a presentation the
              // receiver can seek within can honour anything else.
              currentTime: Option.getOrElse(startAt, () => 0),
              ...Option.match(currentSession, {
                onNone: () => ({}),
                onSome: (value) => ({ sessionId: value })
              }),
              ...(activeTrackIds.length > 0 ? { activeTrackIds } : {})
            })
          ).pipe(
            // Encoding a request we built ourselves can only fail if the
            // schema and this call site have drifted apart, so log it rather
            // than widening the interface's error channel for it.
            Effect.tapError((cause) => Effect.logError(`LOAD failed to encode: ${cause}`)),
            Effect.option
          )
          yield* Option.match(request, {
            onNone: () => Effect.void,
            onSome: (payload) => send(transport, Ns.Media, payload)
          })
        })),

    mediaCommand: (command) =>
      withTransport((transport) =>
        Effect.gen(function*() {
          const media = yield* Ref.get(mediaSessionId)
          const id = yield* nextRequestId
          // Before the first MEDIA_STATUS there is no media session, so there
          // is nothing to command — a failure rather than silence, because the
          // caller would otherwise announce having done it.
          yield* Option.match(media, {
            onNone: () =>
              Effect.fail(
                new CastProtocolError({ message: "nothing is playing on that device" })
              ),
            onSome: (mediaSession) =>
              // The union discriminates on `_tag`; the wire calls it `type`.
              send(transport, Ns.Media, {
                ...Struct.omit(command, ["_tag"]),
                type: command._tag,
                requestId: id,
                mediaSessionId: mediaSession
              })
          })
        })),

    setVolume: (level) =>
      Effect.gen(function*() {
        const id = yield* nextRequestId
        yield* send(RECEIVER, Ns.Receiver, {
          type: "SET_VOLUME",
          requestId: id,
          // No clamp: the brand already rejects anything outside 0..1, so a bad
        // value fails where it was written rather than being silently altered.
        volume: { level }
        })
      }),

    stopReceiver: Effect.gen(function*() {
      const running = yield* Ref.get(sessionId)
      const id = yield* nextRequestId
      yield* Option.match(running, {
        // Nothing has been launched, so there is nothing to stop.
        onNone: () => Effect.void,
        onSome: (launched) =>
          send(RECEIVER, Ns.Receiver, { type: "STOP", requestId: id, sessionId: launched })
      })
    }),

    statuses: Stream.fromPubSub(statuses),
    loadFailures: Stream.fromPubSub(loadFailures)
  }

  return session
})

/** Connect to a device and build a session over that connection. */
export const make = Effect.fn("CastSession.make")(function*(host: string, port: number) {
  return yield* makeOver(yield* CastSocket.connect(host, port))
})
