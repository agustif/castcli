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

import { Duration, Effect, Option, Schedule, Schema, Scope } from "effect"
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

/** What a renderer reports about itself. */
export interface Playback {
  readonly state: "PLAYING" | "PAUSED" | "STOPPED" | "TRANSITIONING"
  readonly position: Brands.Seconds
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

const TransportState = Schema.Literals([
  "PLAYING",
  "PAUSED_PLAYBACK",
  "STOPPED",
  "TRANSITIONING",
  "NO_MEDIA_PRESENT"
])

const asPlaybackState = (state: typeof TransportState.Type): Playback["state"] =>
  state === "PLAYING"
    ? "PLAYING"
    : state === "PAUSED_PLAYBACK"
    ? "PAUSED"
    : state === "TRANSITIONING"
    ? "TRANSITIONING"
    : "STOPPED"

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
            // Both are required. A device handed the wrong content type, or no
            // SOAPAction at all, answers 500 without saying why.
            "content-type": "text/xml; charset=\"utf-8\"",
            soapaction: Soap.actionHeader(action)
          },
          body: HttpBody.text(Soap.envelope(action), "text/xml")
        })
      ).pipe(
        // Retried because a transport failure here usually is not one. UPnP
        // control is a series of small POSTs to a device that closes idle
        // connections aggressively, so a pooled socket is routinely shut just
        // as the next request claims it. Observed within seconds of playback
        // starting, against a device that was working perfectly.
        //
        // Only the send is retried. A fault is the device answering, and
        // answering twice would be worse than answering once.
        Effect.retry(
          Schedule.spaced(Duration.millis(200)).pipe(Schedule.upTo({ times: 2 }))
        ),
        Effect.flatMap((response) => response.text),
        Effect.mapError((cause) =>
          new CastProtocolError({ message: `${action.name} could not be sent: ${cause}` })
        ),
        Effect.flatMap((xml) =>
          Option.match(Soap.parseFault(xml), {
            // A fault is the device declining, and its description is the only
            // useful thing anyone will have to go on.
            onSome: (fault) =>
              Effect.fail(
                new CastProtocolError({
                  message: `${action.name} refused: ${fault.description} (${fault.code})`
                })
              ),
            onNone: () =>
              Option.match(Soap.parseResponse(xml, action.name), {
                onNone: () =>
                  Effect.fail(
                    new CastProtocolError({
                      message: `${action.name} got an answer that was not its own`
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

        return Option.map(
          Schema.decodeUnknownOption(TransportState)(info["CurrentTransportState"]),
          (state) => ({
            state: asPlaybackState(state),
            position: Option.getOrElse(
              Option.flatMap(
                Option.fromNullishOr(position["RelTime"]),
                (value) => fromDuration(value)
              ),
              () => Brands.Seconds.make(0)
            )
          })
        )
      })
    } satisfies Renderer
  })

/** How long to wait for televisions to answer a search. */
export const DISCOVERY_WAIT = Duration.seconds(3)
