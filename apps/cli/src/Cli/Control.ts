// Commands that act on something already playing.
//
// Two protocols, and the difference between them is the shape of this file.
//
// A Cast device holds a *session*: these commands join the one the running
// `cast play` established rather than launching a new receiver, which is the
// whole reason `join` exists separately from `launch` — pausing must not
// restart the film.
//
// UPnP has no session to join. It is request-response over HTTP: there is
// nothing to attach to, nothing to keep alive, and no state on the wire between
// one command and the next, so controlling a renderer is only "find it, post
// the action". That is a genuine difference in the protocols and it is left
// visible rather than smoothed over — the Cast arm below takes a session and a
// status it had to wait for, the DLNA arm takes a renderer and asks it a
// question whenever it wants one. `Match.exhaustive` over the target is what
// keeps every command handling both.

import { Console, Duration, Effect, Match, Option, Schema, Stream } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { AppConfig } from "../Config.ts"
import { Namespace, Session, Session as CastSession } from "@castcli/protocol"
import { Renderer as DlnaRenderer } from "@castcli/dlna"
import { Brands } from "@castcli/domain"
import { CastDevice, VolumeLevel } from "@castcli/domain"
import { SeekTargetError } from "@castcli/domain"
import * as Flags from "./Flags.ts"
import { resolve, search, Target } from "./Target.ts"
import * as TimeCode from "./TimeCode.ts"
import * as State from "../State.ts"

/** Volume as people say it. */
const Percentage = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })))

/** Which device to act on. Shared by every command here, and by `play`. */
const which = { ip: Flags.deviceIp, device: Flags.deviceName }

/** Attach to the running receiver, read one status, and act on it. */
const joinSession = <A, E, R>(
  device: CastDevice,
  act: (
    session: CastSession.Session,
    status: Option.Option<CastSession.PlayerStatus>
  ) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    const session = yield* CastSession.make(device.ip, device.port)
    yield* session.join

    // One status, or none if the receiver is idle. Waited for rather than
    // asked for: the Cast status channel is a subscription the device pushes
    // to, which is why this costs a timeout where the DLNA equivalent is a
    // plain request.
    const status = yield* Stream.runHead(session.statuses).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(5),
        orElse: () => Effect.succeed(Option.none<CastSession.PlayerStatus>())
      })
    )

    const result = yield* act(session, status)
    // Give the outbound command a moment to reach the device before the scope
    // closes and takes the socket with it.
    yield* Effect.sleep(Duration.millis(600))
    return result
  }).pipe(Effect.scoped)

/**
 * Which device was acted on, so the next command need not sweep for it.
 *
 * Written here rather than only in `play` because a control command is just as
 * good a statement of intent as starting a film was: someone who has just
 * paused the renderer in the kitchen means the kitchen when they say `resume`.
 */
const remember: (target: Target) => Effect.Effect<void, never, State.Store> = Match
  .type<Target>().pipe(
    Match.tag("Cast", ({ device }) => State.rememberDevice(device.ip)),
    Match.tag("Dlna", ({ renderer }) => State.rememberRenderer(renderer.friendlyName)),
    Match.exhaustive
  )

/**
 * Resolve a device and act on it, whichever protocol answers.
 *
 * The two handlers are deliberately different shapes. There is no session to
 * hand the DLNA one, because UPnP has none — the renderer it receives is a
 * bundle of control URLs, and every question asked of it is another POST.
 */
const onTarget = <A, E1, E2, R1, R2>(
  options: {
    readonly ip: Option.Option<Brands.Ipv4>
    readonly device: Option.Option<string>
  },
  handlers: {
    readonly onCast: (
      session: CastSession.Session,
      status: Option.Option<CastSession.PlayerStatus>
    ) => Effect.Effect<A, E1, R1>
    readonly onDlna: (renderer: DlnaRenderer.Renderer) => Effect.Effect<A, E2, R2>
  }
) =>
  Effect.gen(function*() {
    const config = yield* AppConfig

    const act = (target: Target) =>
      Effect.tap(
        Match.value(target).pipe(
          Match.tag("Cast", ({ device }) => joinSession(device, handlers.onCast)),
          // Scoped per command: there is no connection to hold open, so the
          // renderer exists for exactly as long as the action takes.
          Match.tag("Dlna", ({ renderer }) =>
            Effect.scoped(Effect.flatMap(DlnaRenderer.connect(renderer), handlers.onDlna))),
          Match.exhaustive
        ),
        // Only once it worked. Remembering a device that turned out to be
        // switched off would make the next command slower, not faster.
        () => remember(target)
      )

    const target = yield* resolve({
      ip: options.ip,
      name: options.device,
      devicePort: config.devicePort,
      timeout: config.discoveryTimeout
    })

    return yield* act(target).pipe(
      // The remembered address is a shortcut, so it must not become a new way
      // to fail: a device that took a different lease is found by discovery,
      // not reported as switched off. An explicit `--ip` is obeyed exactly, so
      // there it is a real failure and is reported as one.
      Option.isSome(options.ip)
        ? (self) => self
        : Effect.catchTag("DeviceUnreachableError", () =>
          Effect.flatMap(
            search({ name: options.device, timeout: config.discoveryTimeout }),
            act
          ))
    )
  })

/**
 * What the device says it is doing.
 *
 * One shape for both protocols, because a person asking what is playing does
 * not care which one answered. The vocabularies differ — a receiver says
 * `BUFFERING`, a renderer says `TRANSITIONING` — and both are shown as the
 * device said them rather than mapped onto some third set of words that neither
 * device would recognise in a bug report.
 */
/**
 * A position is absent, not zero, when the device declines to give one.
 *
 * `RelTime` is legitimately `NOT_IMPLEMENTED` on some renderers. Printing
 * `0:00:00` there would report the film as being at its start, which is a
 * different and wrong claim from "this device does not say".
 */
const report = (
  playing: Option.Option<{
    readonly state: string
    readonly position: Option.Option<Brands.Seconds>
  }>
) =>
  Option.match(playing, {
    onNone: () => Console.log("state     unknown (nothing is playing)"),
    onSome: ({ position, state }) =>
      Console.log(
        `state     ${state}\n` +
          `position  ${
            Option.match(position, {
              onNone: () => "not reported by this device",
              onSome: (at) => `${TimeCode.format(at)} (within the current stream)`
            })
          }`
      )
  })

const status = Command.make(
  "status",
  which,
  Effect.fn(function*({ device, ip }) {
    yield* onTarget({ device, ip }, {
      onCast: (_, current) =>
        report(
          Option.map(current, (playing) => ({
            state: playing.playerState,
            position: Brands.Seconds.makeOption(playing.currentTimeSeconds)
          }))
        ),
      onDlna: (renderer) =>
        Effect.flatMap(renderer.status, (playback) =>
          report(
            Option.map(playback, (playing) => ({
              state: playing.state,
              position: playing.position
            }))
          ))
    })
  })
).pipe(Command.withDescription("Show what the device is playing"))

const pause = Command.make(
  "pause",
  which,
  Effect.fn(function*({ device, ip }) {
    yield* onTarget({ device, ip }, {
      onCast: (session) => session.mediaCommand(Session.MediaCommand.PAUSE()),
      onDlna: (renderer) => renderer.pause
    })
    yield* Console.log("paused")
  })
).pipe(Command.withDescription("Pause playback"))

const resume = Command.make(
  "resume",
  which,
  Effect.fn(function*({ device, ip }) {
    yield* onTarget({ device, ip }, {
      onCast: (session) => session.mediaCommand(Session.MediaCommand.PLAY()),
      onDlna: (renderer) => renderer.resume
    })
    yield* Console.log("resumed")
  })
).pipe(Command.withDescription("Resume playback"))

const toggle = Command.make(
  "toggle",
  which,
  Effect.fn(function*({ device, ip }) {
    yield* onTarget({ device, ip }, {
      // Exhaustive over the receiver's own state vocabulary, so a state added
      // upstream is a compile error rather than a toggle that silently does
      // nothing. BUFFERING and LOADING count as playing: receivers spend a lot
      // of time there, and doing nothing in those states is worse than
      // treating them as playing.
      onCast: (session, current) =>
        Match.value(
          Option.getOrElse(
            Option.map(current, (playing) => playing.playerState),
            (): Namespace.PlayerState => "PLAYING"
          )
        ).pipe(
          Match.whenOr("PAUSED", "IDLE", () =>
            Effect.andThen(
              session.mediaCommand(Session.MediaCommand.PLAY()),
              Console.log("resumed")
            )),
          Match.whenOr("PLAYING", "BUFFERING", "LOADING", () =>
            Effect.andThen(
              session.mediaCommand(Session.MediaCommand.PAUSE()),
              Console.log("paused")
            )),
          Match.exhaustive
        ),
      // The same reasoning over the other protocol's four words. TRANSITIONING
      // is a set that is on its way to playing — treating it as stopped would
      // send `Play` to something already starting.
      onDlna: (renderer) =>
        Effect.flatMap(renderer.status, (playback) =>
          Match.value(
            Option.getOrElse(
              Option.map(playback, (playing) => playing.state),
              (): DlnaRenderer.Playback["state"] => "PLAYING"
            )
          ).pipe(
            Match.whenOr("PAUSED", "STOPPED", () =>
              Effect.andThen(renderer.resume, Console.log("resumed"))),
            Match.whenOr("PLAYING", "TRANSITIONING", () =>
              Effect.andThen(renderer.pause, Console.log("paused"))),
            Match.exhaustive
          ))
    })
  })
).pipe(Command.withDescription("Pause if playing, resume if paused"))

const volume = Command.make(
  "volume",
  {
    ...which,
    // Percentage on the command line, because that is how people say it.
    level: Flag.integer("level").pipe(
      Flag.withSchema(Percentage),
      Flag.withDescription("Volume percentage, 0-100")
    )
  },
  Effect.fn(function*({ device, ip, level }) {
    // Converted once, here, and never again. Three scales are in play — the
    // percentage a person types, the 0..1 a Cast receiver takes, and the whole
    // percent UPnP counts in — and the `VolumeLevel` brand is what stops the
    // first being handed to something expecting the second. A renderer is given
    // a `VolumeLevel` too and multiplies it back up itself, so the conversion
    // lives at exactly one boundary per protocol rather than at this call site.
    const wanted = VolumeLevel.make(level / 100)

    yield* onTarget({ device, ip }, {
      onCast: (session) => session.setVolume(wanted),
      onDlna: (renderer) => renderer.setVolume(wanted)
    })
    yield* Console.log(`volume set to ${level}%`)
  })
).pipe(Command.withDescription("Set the device volume"))

const stop = Command.make(
  "stop",
  which,
  Effect.fn(function*({ device, ip }) {
    yield* onTarget({ device, ip }, {
      onCast: (session) => session.stopReceiver,
      // A renderer has no receiver application to close, so `Stop` is the whole
      // of it: the transport goes to STOPPED and the device drops the pull.
      onDlna: (renderer) => renderer.stop
    })
    yield* Console.log("stopped")
  })
).pipe(Command.withDescription("Stop playback and close the receiver session"))

/**
 * Exactly one of `--to`, `--forward` and `--back`, resolved to a position in
 * the film. `now` is where the viewer currently is, which each protocol has to
 * work out for itself.
 */
const wantedFrom = (
  now: number,
  flags: {
    readonly to: Option.Option<Brands.Seconds>
    readonly forward: Option.Option<Brands.Seconds>
    readonly back: Option.Option<Brands.Seconds>
  }
) =>
  Option.match(
    Option.orElse(
      Option.map(flags.to, (at) => Number(at)),
      () =>
        Option.orElse(
          Option.map(flags.forward, (by) => now + by),
          () => Option.map(flags.back, (by) => now - by)
        )
    ),
    {
      onNone: () =>
        Effect.fail(
          new SeekTargetError({ message: "say where to seek: --to, --forward or --back" })
        ),
      onSome: (at) => Effect.succeed(Brands.Seconds.make(Math.max(0, at)))
    }
  )

/**
 * Seek within what is playing.
 *
 * Three flags rather than one signed argument: `cast seek -5:00` is parsed as a
 * flag by any argument parser, and quoting your way around that is worse than
 * saying what you mean.
 *
 * Whether a seek is *served* or *performed* is the interesting part, and it
 * differs three ways.
 *
 * A Cast receiver handed the progressive stream cannot seek at all: what we
 * serve is a live pipe from ffmpeg with no `Content-Length` and no byte ranges,
 * so there is nothing to seek within — asked to jump forward it re-requests the
 * same URL and starts again from the beginning. That looked like it worked (the
 * command printed a new position while the film played from the old one) which
 * is worse than failing, so the player is asked to restart ffmpeg at the new
 * offset instead. Under HLS every segment is addressable and the receiver seeks
 * for itself.
 *
 * A renderer always seeks for itself. It was handed a plain URL from the same
 * server, which answers byte ranges, so `Seek` is a real seek and nothing
 * restarts — the "reload" mechanism has no equivalent here and is not wanted.
 *
 * The arithmetic still matters for relative seeks: both devices report time
 * *within the current stream*, which begins wherever the last load started, so
 * a position in the film is `offset + reported`.
 */
const seek = Command.make(
  "seek",
  {
    ...which,
    to: Flag.string("to").pipe(
      Flag.withSchema(TimeCode.TimeCode),
      Flag.withDescription("Absolute position: seconds, mm:ss or h:mm:ss"),
      Flag.optional
    ),
    forward: Flag.string("forward").pipe(
      Flag.withSchema(TimeCode.TimeCode),
      Flag.withDescription("Skip forward by this much"),
      Flag.optional
    ),
    back: Flag.string("back").pipe(
      Flag.withSchema(TimeCode.TimeCode),
      Flag.withDescription("Rewind by this much"),
      Flag.optional
    )
  },
  Effect.fn(function*({ back, device, forward, ip, to }) {
    const active = yield* State.activeStream
    const offset = Option.match(active, {
      onNone: () => Brands.Seconds.make(0),
      onSome: (stream) => stream.offsetSeconds
    })
    const flags = { to, forward, back }

    yield* onTarget({ device, ip }, {
      onCast: (session, current) =>
        Effect.gen(function*() {
          const within = Option.match(current, {
            onNone: () => 0,
            onSome: (playing) => playing.currentTimeSeconds
          })
          const wanted = yield* wantedFrom(offset + within, flags)

          // Nothing is playing to seek within or to reload. Only checkable on
          // this side: `play` publishes the active stream from the Cast path.
          yield* Effect.when(
            Effect.fail(
              new SeekTargetError({
                message: "nothing is playing — start it with `cast play --seek`"
              })
            ),
            Effect.succeed(Option.isNone(active))
          )

          const seekable = Option.getOrElse(
            Option.map(active, (stream) => stream.seekable === true),
            () => false
          )

          yield* Effect.when(
            session.mediaCommand(Session.MediaCommand.SEEK({ currentTime: wanted })),
            Effect.succeed(seekable)
          )
          yield* Effect.when(State.requestSeek(wanted), Effect.succeed(!seekable))

          yield* Console.log(
            `seeking to ${TimeCode.format(wanted)}${seekable ? "" : " (the stream restarts there)"}`
          )
        }),

      onDlna: (renderer) =>
        Effect.gen(function*() {
          // Where it is now comes from the device rather than from a file: UPnP
          // answers `GetPositionInfo` on demand, so there is no reason to
          // believe anything else.
          const playback = yield* renderer.status
          const within = Option.match(playback, {
            onNone: () => 0,
            onSome: (playing) => Number(playing.position)
          })
          const wanted = yield* wantedFrom(offset + within, flags)

          // `REL_TIME` is relative to the start of the track, and the track is
          // the stream we served from `offset` — so a position in the film has
          // to have the offset taken back off before the device sees it.
          //
          // Nothing is checked against the state file first. A renderer answers
          // for itself whether it can seek right now — a fault, with its reason
          // — and that is a better answer than one guessed from a file the
          // DLNA path does not write.
          yield* renderer.seek(Brands.Seconds.make(Math.max(0, wanted - offset)))
          yield* Console.log(`seeking to ${TimeCode.format(wanted)}`)
        })
    })
  })
).pipe(Command.withDescription("Seek within what is playing"))

export const all = [status, pause, resume, toggle, seek, volume, stop]
