// Commands that act on a session already playing.
//
// These attach to the running receiver rather than launching a new one, so
// pausing does not restart the film. That is the whole reason `join` exists
// separately from `launch`.

import { Console, Duration, Effect, Match, Option, Stream } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { AppConfig } from "../Config.ts"
import * as CastSession from "../Cast/Session.ts"
import * as Mdns from "../Platform/Mdns.ts"
import * as Brands from "../Domain/Brands.ts"
import { CastDevice } from "../Domain/Device.ts"
import { DeviceNotFoundError } from "../Domain/Errors.ts"
import * as TimeCode from "./TimeCode.ts"

const CAST_SERVICE = "_googlecast._tcp.local"

const deviceIp = Flag.string("ip").pipe(
  Flag.withSchema(Brands.Ipv4),
  Flag.withDescription("Device address, skipping discovery"),
  Flag.optional
)

/** Resolve a device the same way `play` does, so the flags behave identically. */
const target = Effect.fn("Control.target")(function*(ip: Option.Option<Brands.Ipv4>) {
  const config = yield* AppConfig
  return yield* Option.match(ip, {
    onSome: (address) =>
      Effect.succeed(
        new CastDevice({
          name: address,
          ip: address,
          port: Brands.port(config.devicePort)
        })
      ),
    onNone: () =>
      Effect.flatMap(
        Mdns.discoverWithRetry(CAST_SERVICE, config.discoveryTimeout),
        (devices) =>
          Option.match(Option.fromNullishOr(devices[0]), {
            onSome: (device) => Effect.succeed(device),
            onNone: () =>
              Effect.fail(
                new DeviceNotFoundError({ query: "(first available)", found: [] })
              )
          })
      )
  })
})

/** Attach, read one status, act on it, and report what the receiver now says. */
const withSession = <A>(
  ip: Option.Option<Brands.Ipv4>,
  act: (
    session: CastSession.Session,
    status: Option.Option<CastSession.PlayerStatus>
  ) => Effect.Effect<A>
) =>
  Effect.gen(function*() {
    const device = yield* target(ip)
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
    yield* withSession(ip, (session) => session.mediaCommand("PAUSE"))
    yield* Console.log("paused")
  })
).pipe(Command.withDescription("Pause playback"))

const resume = Command.make(
  "resume",
  { ip: deviceIp },
  Effect.fn(function*({ ip }) {
    yield* withSession(ip, (session) => session.mediaCommand("PLAY"))
    yield* Console.log("resumed")
  })
).pipe(Command.withDescription("Resume playback"))

const toggle = Command.make(
  "toggle",
  { ip: deviceIp },
  Effect.fn(function*({ ip }) {
    yield* withSession(ip, (session, current) =>
      // Anything that is not PAUSED counts as playing: receivers spend a lot of
      // time in BUFFERING, and a toggle that silently does nothing there is
      // worse than one that treats it as playing.
      Match.value(
        Option.match(current, {
          onNone: () => "PLAYING" as const,
          onSome: (playing) => playing.playerState
        })
      ).pipe(
        Match.when("PAUSED", () =>
          Effect.andThen(session.mediaCommand("PLAY"), Console.log("resumed"))),
        Match.orElse(() =>
          Effect.andThen(session.mediaCommand("PAUSE"), Console.log("paused")))
      ))
  })
).pipe(Command.withDescription("Pause if playing, resume if paused"))

const volume = Command.make(
  "volume",
  {
    ip: deviceIp,
    level: Flag.integer("level").pipe(
      Flag.withDescription("Volume percentage, 0-100")
    )
  },
  Effect.fn(function*({ ip, level }) {
    yield* withSession(ip, (session) => session.setVolume(level / 100))
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

export const all = [status, pause, resume, toggle, volume, stop]
