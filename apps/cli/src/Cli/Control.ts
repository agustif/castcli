// Commands that act on a session already playing.
//
// These attach to the running receiver rather than launching a new one, so
// pausing does not restart the film. That is the whole reason `join` exists
// separately from `launch`.

import { Console, Duration, Effect, Match, Option, Schema, Stream } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { AppConfig } from "../Config.ts"
import { Namespace, Session, Session as CastSession } from "@castcli/protocol"
import { Mdns } from "@castcli/platform"
import { Brands, Port } from "@castcli/domain"
import { CastDevice, VolumeLevel } from "@castcli/domain"
import { DeviceNotFoundError } from "@castcli/domain"
import * as TimeCode from "./TimeCode.ts"
import * as State from "../State.ts"
import { SeekTargetError } from "@castcli/domain"

/** Volume as people say it. */
const Percentage = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })))

const CAST_SERVICE = "_googlecast._tcp.local"

const deviceIp = Flag.string("ip").pipe(
  Flag.withSchema(Brands.Ipv4),
  Flag.withDescription("Device address, skipping discovery"),
  Flag.optional
)

const deviceAt = (address: Brands.Ipv4) =>
  Effect.map(AppConfig, (config) =>
    new CastDevice({ name: address, ip: address, port: Port.make(config.devicePort) }))

/** The device the last `cast play` used, if this machine has ever run one. */
const remembered = Effect.map(State.rememberedDevice, (address) => address)

const discovered = Effect.gen(function*() {
  const config = yield* AppConfig
  const devices = yield* Mdns.discoverWithRetry(CAST_SERVICE, config.discoveryTimeout)
  return yield* Option.match(Option.fromNullishOr(devices[0]), {
    onSome: (device) => Effect.succeed(device),
    onNone: () => Effect.fail(new DeviceNotFoundError({ query: "(first available)", found: [] }))
  })
})

/** Attach, read one status, act on it, and report what the receiver now says. */
const withSession = <A, E, R>(
  ip: Option.Option<Brands.Ipv4>,
  act: (
    session: CastSession.Session,
    status: Option.Option<CastSession.PlayerStatus>
  ) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    // An explicit --ip is obeyed exactly. Otherwise the device from the last
    // session is tried first, because a four second mDNS sweep before every
    // pause is most of what those commands cost — and if that address has gone
    // stale, discovery still runs, so the shortcut can only save time.
    const shortcut = Option.isSome(ip) ? ip : yield* remembered
    const attempt = (device: CastDevice) => run(device, act)

    return yield* Option.match(shortcut, {
      onNone: () => Effect.flatMap(discovered, attempt),
      onSome: (address) =>
        Effect.flatMap(deviceAt(address), attempt).pipe(
          Option.isSome(ip)
            ? (self) => self
            : Effect.catchTag(
              "DeviceUnreachableError",
              () => Effect.flatMap(discovered, attempt)
            )
        )
    })
  })

const run = <A, E, R>(
  device: CastDevice,
  act: (
    session: CastSession.Session,
    status: Option.Option<CastSession.PlayerStatus>
  ) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    const session = yield* CastSession.make(device.ip, device.port)
    yield* session.join

    // One status, or none if the receiver is idle.
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

const report = (status: Option.Option<CastSession.PlayerStatus>) =>
  Option.match(status, {
    onNone: () => Console.log("state     unknown (nothing is playing)"),
    onSome: (playing) =>
      Console.log(
        `state     ${playing.playerState}\n` +
          `position  ${TimeCode.format(playing.currentTimeSeconds)} (within the current stream)`
      )
  })

const status = Command.make(
  "status",
  { ip: deviceIp },
  Effect.fn(function*({ ip }) {
    yield* withSession(ip, (_, current) => report(current))
  })
).pipe(Command.withDescription("Show what the device is playing"))

const pause = Command.make(
  "pause",
  { ip: deviceIp },
  Effect.fn(function*({ ip }) {
    yield* withSession(ip, (session) => session.mediaCommand(Session.MediaCommand.PAUSE()))
    yield* Console.log("paused")
  })
).pipe(Command.withDescription("Pause playback"))

const resume = Command.make(
  "resume",
  { ip: deviceIp },
  Effect.fn(function*({ ip }) {
    yield* withSession(ip, (session) => session.mediaCommand(Session.MediaCommand.PLAY()))
    yield* Console.log("resumed")
  })
).pipe(Command.withDescription("Resume playback"))

const toggle = Command.make(
  "toggle",
  { ip: deviceIp },
  Effect.fn(function*({ ip }) {
    yield* withSession(ip, (session, current) =>
      // Exhaustive over the receiver's own state vocabulary, so a state added
      // upstream is a compile error rather than a toggle that silently does
      // nothing. BUFFERING and LOADING count as playing: receivers spend a lot
      // of time there, and doing nothing in those states is worse than
      // treating them as playing.
      Match.value(
        Option.getOrElse(
          Option.map(current, (playing) => playing.playerState),
          (): Namespace.PlayerState => "PLAYING"
        )
      ).pipe(
        Match.whenOr("PAUSED", "IDLE", () =>
          Effect.andThen(session.mediaCommand(Session.MediaCommand.PLAY()), Console.log("resumed"))),
        Match.whenOr("PLAYING", "BUFFERING", "LOADING", () =>
          Effect.andThen(session.mediaCommand(Session.MediaCommand.PAUSE()), Console.log("paused"))),
        Match.exhaustive
      ))
  })
).pipe(Command.withDescription("Pause if playing, resume if paused"))

const volume = Command.make(
  "volume",
  {
    ip: deviceIp,
    // Percentage on the command line, because that is how people say it;
    // decoded to the receiver's 0..1 scale before it leaves this module.
    level: Flag.integer("level").pipe(
      Flag.withSchema(Percentage),
      Flag.withDescription("Volume percentage, 0-100")
    )
  },
  Effect.fn(function*({ ip, level }) {
    yield* withSession(ip, (session) => session.setVolume(VolumeLevel.make(level / 100)))
    yield* Console.log(`volume set to ${level}%`)
  })
).pipe(Command.withDescription("Set the device volume"))

const stop = Command.make(
  "stop",
  { ip: deviceIp },
  Effect.fn(function*({ ip }) {
    yield* withSession(ip, (session) => session.stopReceiver)
    yield* Console.log("stopped")
  })
).pipe(Command.withDescription("Stop playback and close the receiver session"))

/**
 * Seek within what is playing.
 *
 * Three flags rather than one signed argument: `cast seek -5:00` is parsed as a
 * flag by any argument parser, and quoting your way around that is worse than
 * saying what you mean.
 *
 * Every seek is served by reloading, never by the receiver's own `SEEK`. What
 * we serve is a live pipe from ffmpeg with no `Content-Length` and no byte
 * ranges, so there is nothing for the receiver to seek *within*: asked to jump
 * forward, it re-requests the same URL and starts the stream again from its
 * beginning. That looked like it worked — the command printed a new position
 * while the film played from the old one — which is worse than failing. So the
 * player is asked to restart ffmpeg at the new offset, which is the same thing
 * `--seek` does at startup and the only mechanism that actually moves.
 *
 * The arithmetic still matters for relative seeks: the receiver reports time
 * *within the current stream*, which begins wherever the last LOAD started, so
 * a position in the film is `offset + reported`. `play` publishes that offset.
 */
const seek = Command.make(
  "seek",
  {
    ip: deviceIp,
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
  Effect.fn(function*({ back, forward, ip, to }) {
    const active = yield* State.activeStream
    const offset = Option.match(active, {
      onNone: () => Brands.Seconds.make(0),
      onSome: (stream) => stream.offsetSeconds
    })

    yield* withSession(ip, (session, current) =>
      Effect.gen(function*() {
        const within = Option.match(current, {
          onNone: () => 0,
          onSome: (playing) => playing.currentTimeSeconds
        })
        const now = offset + within

        // Exactly one of the three, resolved to a position in the film.
        const wanted = yield* Option.match(
          Option.orElse(
            Option.map(to, (at) => Number(at)),
            () =>
              Option.orElse(
                Option.map(forward, (by) => now + by),
                () => Option.map(back, (by) => now - by)
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

        // Nothing is playing to seek within or to reload.
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

        // Under HLS every segment of the film is addressable, so the receiver
        // seeks itself and nothing restarts. Progressively there is nothing to
        // seek within — a live pipe has no byte ranges — so the player is asked
        // to restart ffmpeg at the new offset instead.
        yield* Effect.when(
          session.mediaCommand(Session.MediaCommand.SEEK({ currentTime: wanted })),
          Effect.succeed(seekable)
        )
        yield* Effect.when(State.requestSeek(wanted), Effect.succeed(!seekable))

        yield* Console.log(
          `seeking to ${TimeCode.format(wanted)}${seekable ? "" : " (the stream restarts there)"}`
        )
      }))
  })
).pipe(Command.withDescription("Seek within what is playing"))

export const all = [status, pause, resume, toggle, seek, volume, stop]
