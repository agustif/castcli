// Talking to a television that is not a Chromecast.
//
// The shape is deliberately the same as the Cast session: connect to a device,
// hand it something to play, then pause, seek, and ask where it has got to.
// What differs is everything underneath — SOAP over HTTP instead of protobuf
// over TLS, and a device that is told a URL rather than one that launches an
// application first.
//
// The similarity is not a coincidence and it is not yet an abstraction. Both
// protocols are *pull* models: we serve the file and the television fetches it,
// which is why the same media server feeds both. When there is a third, the
// interface these two share is worth extracting; with two it would be a shape
// traced around the first one.

import { Cause, Duration, Effect, Option, Schedule, Schema, Scope } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Brands, CastProtocolError } from "@castcli/domain"
import * as Actions from "./GeneratedActions.ts"
import * as Description from "./Description.ts"
import * as Didl from "./Didl.ts"
import * as Soap from "./Soap.ts"

/**
 * Instance zero.
 *
 * AVTransport is specified for devices that can play several things at once,
 * and no consumer television does; every one of them uses instance zero and
 * several reject anything else.
 */
const INSTANCE = "0"

/**
 * The content type UPnP fixes for a control request, charset included.
 *
 * It is given to the *body* rather than set as a header, which looks like a
 * detail and is not: `HttpClientRequest.post` applies `headers` first and then
 * the body, and setting a body overwrites `content-type` with the body's own.
 * Set both ways round, as it was, the envelope went out as bare `text/xml`
 * however loudly the call site asked for the charset — and a device that
 * insists on it answers 500 with nothing to say why.
 */
const CONTENT_TYPE = `text/xml; charset="utf-8"`

/**
 * How long one control request may take before the renderer counts as gone.
 *
 * A television that has gone to sleep, or moved off the network, accepts the
 * connection and then never answers it, and TCP's own timeout is measured in
 * minutes — three retried attempts of it is the better part of four. Without a
 * limit of our own `cast play` printed nothing and hung, which is precisely the
 * failure `protocol/CastSocket` needed `CONNECT_TIMEOUT_MS` to fix, one
 * protocol over. Five seconds is the same budget it uses and is far longer than
 * a set on the same LAN takes to answer a SOAP post.
 */
const REQUEST_TIMEOUT = Duration.seconds(5)

/** What a renderer reports about itself. */
export interface Playback {
  readonly state: "PLAYING" | "PAUSED" | "STOPPED" | "TRANSITIONING"
  /**
   * Where the device says it has got to, when it says.
   *
   * `Option`, not a zero. `RelTime` is legitimately `NOT_IMPLEMENTED` on some
   * renderers, and a fabricated zero is written to the resume point once a
   * second by the player — so a set that does not report a position would
   * continuously reset how far you had watched, which looks like the film
   * refusing to remember rather than the device declining to answer.
   */
  readonly position: Option.Option<Brands.Seconds>
}

export interface Media {
  readonly url: string
  readonly contentType: string
  readonly title: string
  readonly durationSeconds: Option.Option<number>
  readonly subtitleUrl: Option.Option<string>
}

export interface Renderer {
  readonly name: string
  readonly play: (media: Media) => Effect.Effect<void, CastProtocolError>
  readonly resume: Effect.Effect<void, CastProtocolError>
  readonly pause: Effect.Effect<void, CastProtocolError>
  readonly stop: Effect.Effect<void, CastProtocolError>
  readonly seek: (to: Brands.Seconds) => Effect.Effect<void, CastProtocolError>
  readonly setVolume: (level: Brands.VolumeLevel) => Effect.Effect<void, CastProtocolError>
  readonly status: Effect.Effect<Option.Option<Playback>, CastProtocolError>
}

/**
 * `H:MM:SS`, which is how AVTransport writes a position.
 *
 * Not `HH:MM:SS`: the specification writes the hours field without padding and
 * some devices reject the padded form, which is the sort of thing that makes a
 * seek silently do nothing.
 */
const asDuration = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60) % 60
  const remaining = whole % 60
  return `${Math.floor(whole / 3600)}:${String(minutes).padStart(2, "0")}:${
    String(remaining).padStart(2, "0")
  }`
}

/** `0:12:34` back to seconds, for reading a position out of a device. */
const fromDuration = (value: string): Option.Option<Brands.Seconds> => {
  const parts = value.split(":").map((part) => Number(part))
  return parts.length !== 3 || parts.some((part) => Number.isNaN(part))
    ? Option.none()
    : Brands.Seconds.makeOption(
      (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)
    )
}

/**
 * Every state AVTransport:1 defines. `PAUSED_RECORDING` and `RECORDING` are in
 * the specification and were missing from this set, which cost more than the
 * two words: an unrecognised state made the decode fail, and a failed decode
 * threw away the whole reading — the position with it, which `cast play` saves
 * once a second as where to resume.
 *
 * The vendored SCPD is no help in settling the list: its `allowedValueList`
 * names only `STOPPED` and `PLAYING`, because the rest are optional for a
 * device to implement and not optional for a controller to understand.
 */
const TransportState = Schema.Literals([
  "PLAYING",
  "PAUSED_PLAYBACK",
  "PAUSED_RECORDING",
  "RECORDING",
  "STOPPED",
  "TRANSITIONING",
  "NO_MEDIA_PRESENT"
])

const decodeTransportState = Schema.decodeUnknownOption(TransportState)

/**
 * What each of them means to something that only wants to play a film.
 *
 * A record rather than a chain of comparisons, so the compiler requires an
 * answer for every state the schema admits. `NO_MEDIA_PRESENT` is stopped —
 * there is nothing to be part-way through.
 *
 * The two recording states are `TRANSITIONING`, which is the least wrong of the
 * four words available: the set is busy with something that is not our film, so
 * `STOPPED` would read as our playback having ended (and `cast toggle` would
 * answer it by sending `Play`), while `PLAYING` and `PAUSED` both claim
 * something specific about a stream that is not on screen. A fifth word would
 * be the honest answer and is deliberately not added here — `Playback["state"]`
 * is matched exhaustively in the CLI, so widening it is a change to every site
 * that acts on a device, which is a bigger decision than this file gets to make
 * on its own.
 */
const PLAYBACK_STATE: Record<typeof TransportState.Type, Playback["state"]> = {
  PLAYING: "PLAYING",
  PAUSED_PLAYBACK: "PAUSED",
  PAUSED_RECORDING: "TRANSITIONING",
  RECORDING: "TRANSITIONING",
  STOPPED: "STOPPED",
  TRANSITIONING: "TRANSITIONING",
  NO_MEDIA_PRESENT: "STOPPED"
}

/**
 * Total, deliberately. A word outside the specification is a word this
 * controller does not act on, not a reason to discard the answer it came in —
 * and the answer it came in carries the position, which `cast play` saves once
 * a second as where to resume.
 */
const asPlaybackState = (state: unknown): Playback["state"] =>
  Option.match(decodeTransportState(state), {
    onNone: (): Playback["state"] => "TRANSITIONING",
    onSome: (known) => PLAYBACK_STATE[known]
  })

/**
 * What to say about a refusal.
 *
 * The code is the message and the sentence around it is optional: several
 * renderers send `errorCode` with no `errorDescription`, and interpolating that
 * into "refused: %s (%s)" produced `Play refused:  (701)` — a hole where the
 * only two useful things anyone has are the action and the number.
 */
const refused = (action: string, fault: Soap.Fault): string =>
  fault.description.length === 0
    ? `${action} refused with UPnP error ${fault.code}`
    : `${action} refused: ${fault.description} (${fault.code})`

/**
 * What to say about a body that is neither this action's response nor a fault.
 *
 * The HTTP status used to be dropped on the floor here, and it is the whole
 * diagnosis: a renderer answering 404 means the control URL is wrong — the
 * commonest DLNA integration bug of all, which is why `Description` resolves
 * them — and reporting that as an answer belonging to some other action sends
 * the reader hunting a pipelining bug that does not exist. A 200 really is that
 * other case, so it keeps the wording it had.
 */
const unreadable = (action: string, controlUrl: string, status: number): string =>
  status === 200
    ? `${action} got an answer that was not its own`
    : `${action} failed: ${controlUrl} answered ${status} with no UPnP fault in it`

/**
 * Connect to a renderer found by discovery.
 *
 * There is no session to establish — UPnP is request-response over HTTP, with
 * no connection to keep alive and no application to launch. That makes this far
 * simpler than its Cast counterpart, and also means a device that has gone away
 * is only discovered on the next request.
 */
export const connect = (
  device: Description.Renderer
): Effect.Effect<Renderer, never, HttpClient.HttpClient | Scope.Scope> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient

    /** POST one action and read its outputs, or fail with what the device said. */
    const invoke = (
      controlUrl: string,
      action: Soap.Action
    ): Effect.Effect<Record<string, string>, CastProtocolError> =>
      client.execute(
        HttpClientRequest.post(controlUrl, {
          headers: {
            // A device handed no SOAPAction at all answers 500 without saying
            // why. The content type is just as required and is set on the body
            // instead, because a body set afterwards overwrites this header —
            // see `CONTENT_TYPE`.
            soapaction: Soap.actionHeader(action)
          },
          body: HttpBody.text(Soap.envelope(action), CONTENT_TYPE)
        })
      ).pipe(
        // Inside the retry rather than around it, so an attempt that follows a
        // reset connection gets its own five seconds rather than the remains of
        // the previous one's.
        Effect.timeout(REQUEST_TIMEOUT),
        // Retried because a transport failure here usually is not one. UPnP
        // control is a series of small POSTs to a device that closes idle
        // connections aggressively, so a pooled socket is routinely shut just
        // as the next request claims it. Observed within seconds of playback
        // starting, against a device that was working perfectly.
        //
        // Only the send is retried. A fault is the device answering, and
        // answering twice would be worse than answering once.
        //
        // A timeout is not retried either. The failure this exists for — a
        // connection shut under us — comes back at once, so retrying costs
        // nothing; a silence has already cost the whole timeout, and trying it
        // twice more only makes a sleeping television take three times as long
        // to be declared asleep.
        Effect.retry({
          schedule: Schedule.spaced(Duration.millis(200)).pipe(Schedule.upTo({ times: 2 })),
          while: (cause) => !Cause.isTimeoutError(cause)
        }),
        // The status travels with the body because it is the only evidence
        // about a body that is not SOAP; read alone, a 404 page and a truncated
        // envelope are the same unparseable string.
        Effect.flatMap((response) =>
          Effect.map(response.text, (xml) => ({ status: response.status, xml }))
        ),
        Effect.mapError((cause) =>
          new CastProtocolError({
            message: Cause.isTimeoutError(cause)
              ? `${action.name} timed out after ` +
                `${Duration.toSeconds(REQUEST_TIMEOUT)}s: ${controlUrl} did not answer — ` +
                "the renderer is off, asleep, or on another network"
              : `${action.name} could not be sent: ${cause}`
          })
        ),
        Effect.flatMap(({ status, xml }) =>
          Option.match(Soap.parseFault(xml), {
            // A fault is the device declining, and its code is the only useful
            // thing anyone will have to go on. Read before the status is,
            // because devices exist that send one with a 200.
            onSome: (fault) =>
              Effect.fail(new CastProtocolError({ message: refused(action.name, fault) })),
            onNone: () =>
              Option.match(Soap.parseResponse(xml, action.name), {
                onNone: () =>
                  Effect.fail(
                    new CastProtocolError({
                      message: unreadable(action.name, controlUrl, status)
                    })
                  ),
                onSome: (outputs) => Effect.succeed(outputs)
              })
          })
        )
      )

    const transport = (action: Soap.Action) => invoke(device.avTransport.controlUrl, action)

    const play = (media: Media) =>
      Effect.gen(function*() {
        // The metadata is not decoration. Several televisions play nothing at
        // all when handed a bare URL, and most of the rest show no title and no
        // seek bar without it.
        yield* transport(
          Actions.setAVTransportURI({
            InstanceID: INSTANCE,
            CurrentURI: media.url,
            CurrentURIMetaData: Didl.videoItem({
              title: media.title,
              url: media.url,
              contentType: media.contentType,
              durationSeconds: media.durationSeconds,
              subtitleUrl: media.subtitleUrl
            })
          })
        )

        // Setting the URI does not start it. A device left here sits on a black
        // screen, which reads as a failure to load rather than a missing Play.
        yield* transport(Actions.play({ InstanceID: INSTANCE, Speed: "1" }))
      })

    return {
      name: device.friendlyName,
      play,
      resume: Effect.asVoid(transport(Actions.play({ InstanceID: INSTANCE, Speed: "1" }))),
      pause: Effect.asVoid(transport(Actions.pause({ InstanceID: INSTANCE }))),
      stop: Effect.asVoid(transport(Actions.stop({ InstanceID: INSTANCE }))),

      seek: (to: Brands.Seconds) =>
        Effect.asVoid(
          transport(
            Actions.seek({
              InstanceID: INSTANCE,
              // Relative to the start of the track. `ABS_TIME` is the
              // alternative and is only meaningful for broadcast media.
              Unit: "REL_TIME",
              Target: asDuration(to)
            })
          )
        ),

      setVolume: (level: Brands.VolumeLevel) =>
        Option.match(device.renderingControl, {
          onNone: () =>
            Effect.fail(
              new CastProtocolError({ message: "this device does not offer volume control" })
            ),
          onSome: (service) =>
            Effect.asVoid(
              invoke(
                service.controlUrl,
                Actions.setVolume({
                  InstanceID: INSTANCE,
                  // The only channel every device implements; `LF`/`RF` exist
                  // and are widely unsupported.
                  Channel: "Master",
                  // UPnP counts volume in whole percent, where Cast uses 0..1.
                  DesiredVolume: String(Math.round(level * 100))
                })
              )
            )
        }),

      status: Effect.gen(function*() {
        const info = yield* transport(Actions.getTransportInfo({ InstanceID: INSTANCE }))
        const position = yield* transport(Actions.getPositionInfo({ InstanceID: INSTANCE }))

        // None only when the device did not report a state at all. An
        // unrecognised one is a state we do not act on, not a missing answer.
        return Option.map(
          Option.fromNullishOr(info["CurrentTransportState"]),
          (state): Playback => ({
            state: asPlaybackState(state),
            position: Option.flatMap(
              Option.fromNullishOr(position["RelTime"]),
              (value) => fromDuration(value)
            )
          })
        )
      })
    } satisfies Renderer
  })


