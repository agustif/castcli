#!/usr/bin/env node
// cast — stream a local video file to a Google Cast device.
//
// Why this exists: VLC builds the pull-URL it hands the TV from whichever local
// address its socket happens to be bound to. When the device resolves over IPv6
// it advertises a link-local address with a zone index
// (http://fe80::...%en0:8010/...) which is unroutable from the TV, so every
// load fails. Here the advertised address is an explicit LAN IPv4.

import {
  Array,
  Console,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  Stream
} from "effect"
import { Argument, Command } from "effect/unstable/cli"
import * as Flags from "../Cli/Flags.ts"
import * as Control from "../Cli/Control.ts"
import * as TimeCode from "../Cli/TimeCode.ts"
import { HttpRouter } from "effect/unstable/http"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as os from "node:os"
import * as path from "node:path"

import { AppConfig } from "../Config.ts"
import { canStreamCopy, Ffmpeg } from "@castcli/media"
import { Ipv4, Port, type Rung, Seconds, StreamIndex, TrackId, describeRung } from "@castcli/domain"
import {
  ConnectionLostError,
  DeviceNotFoundError,
  EmptyLadderError,
  NoLocalAddressError,
  NoVideoStreamError
} from "@castcli/domain"
import { CastDevice } from "@castcli/domain"
import { Mdns } from "@castcli/platform"
import { Controller as Quality } from "@castcli/quality"
import { Ladder } from "@castcli/quality"
import { Session as CastSession } from "@castcli/protocol"
import { Media } from "@castcli/protocol"
import { HttpServer as HttpServerPlatform } from "@castcli/platform"
import { routes, type SessionState } from "../Server/Routes.ts"

const CAST_SERVICE = "_googlecast._tcp.local"

/** Unique only within one MediaInformation, so a constant is enough. */
const SUBTITLE_TRACK_ID = TrackId.make(1)

/**
 * Pick the LAN IPv4 to advertise. Never IPv6: a link-local v6 address with a
 * zone index is precisely the bug this tool exists to route around.
 */
const localAddress = (override: Option.Option<string>) =>
  Option.match(override, {
    onSome: (value) => Effect.succeed(value),
    onNone: () => {
      const interfaces = os.networkInterfaces()
      // en0/en1 first: on a Mac those are the real network interfaces, and
      // preferring them avoids advertising a VPN or container bridge address.
      const candidate = ["en0", "en1", ...Object.keys(interfaces)]
        .flatMap((name) => interfaces[name] ?? [])
        .find((address) => address.family === "IPv4" && !address.internal)
      return Option.match(Option.fromNullishOr(candidate), {
        onSome: (address) => Effect.succeed(address.address),
        onNone: () => Effect.fail(new NoLocalAddressError())
      })
    }
  })


// ------------------------------------------------------------------- scan

const scan = Command.make(
  "scan",
  {},
  Effect.fn(function*() {
    const config = yield* AppConfig
    yield* Console.log("scanning for Cast devices…")
    const devices = yield* Mdns.discoverWithRetry(CAST_SERVICE, config.discoveryTimeout)
    yield* Effect.when(
      Console.log("none found — check the TV is awake and on this network"),
      Effect.succeed(devices.length === 0)
    )
    yield* Effect.forEach(devices, (device) =>
      Console.log(
        `\n  ${device.name}\n    address   ${device.address}` +
          `\n    model     ${device.model ?? "unknown"}` +
          `\n    status    ${device.status ?? "idle"}`
      ), { discard: true })
    yield* Effect.when(
      Effect.flatMap(
        localAddress(config.advertiseHost),
        (address) => Console.log(`\nlocal address to advertise: ${address}`)
      ),
      Effect.succeed(devices.length > 0)
    )
  })
).pipe(Command.withDescription("List Cast devices on this network"))

// ------------------------------------------------------------------- play

const discoverDevice = Effect.fn("cast.discoverDevice")(function*(
  name: Option.Option<string>,
  timeout: Duration.Duration
) {
  yield* Console.log("scanning for Cast devices…")
  const devices = yield* Mdns.discoverWithRetry(CAST_SERVICE, timeout)
  const wanted = Option.getOrUndefined(name)
  const found = Option.fromNullishOr(
    wanted === undefined
      ? devices[0]
      : devices.find((device) => device.name.toLowerCase().includes(wanted.toLowerCase()))
  )
  return yield* Option.match(found, {
    onSome: (device) => Effect.succeed(device),
    onNone: () =>
      Effect.fail(
        new DeviceNotFoundError({
          query: wanted ?? "(first available)",
          found: devices.map((device) => device.name)
        })
      )
  })
})

/**
 * mDNS unicast replies get dropped often enough on a congested network that an
 * explicit `--ip` is worth having: it skips discovery entirely.
 */
const resolveDevice = (
  ip: Option.Option<string>,
  name: Option.Option<string>,
  devicePort: number,
  timeout: Duration.Duration
) =>
  Option.match(ip, {
    onSome: (address) =>
      Effect.succeed(
        new CastDevice({
          name: address,
          ip: Ipv4.make(address),
          port: Port.make(devicePort)
        })
      ),
    onNone: () => discoverDevice(name, timeout)
  })

const play = Command.make(
  "play",
  {
    file: Flags.mediaFile,
    device: Flags.deviceName,
    ip: Flags.deviceIp,
    audio: Flags.audioStream,
    subs: Flags.subtitleStream,
    seek: Flags.seek
  },
  Effect.fn(function*({ audio, device, file, ip, seek, subs }) {
    const config = yield* AppConfig
    const ffmpeg = yield* Ffmpeg
    const absolute = path.resolve(file)

    const info = yield* ffmpeg.probe(absolute)

    // A file with no video stream is not something this tool can cast, and
    // `--streams` is a pure inspection that should never open a socket.
    const video = yield* Option.match(Option.fromNullishOr(info.video), {
      onNone: () =>
        Effect.andThen(
          Console.error("no video stream in this file"),
          Effect.fail(new NoVideoStreamError({ path: absolute }))
        ),
      onSome: (found) => Effect.succeed(found)
    })

    const firstAudio = info.audioStreams[0]?.index
    const audioIndex = Option.getOrElse(
      audio,
      () => firstAudio === undefined ? null : StreamIndex.make(firstAudio)
    )
    const subtitleIndex = Option.getOrUndefined(subs) ?? null
    const subtitleLanguage = info.subtitleStreams.find((s) => s.index === subtitleIndex)?.language ??
      "und"

    // Extracted once up front rather than per request: a Cast receiver handed a
    // slowly-arriving text track stacks cues on screen instead of replacing
    // them, and re-running ffmpeg per seek costs seconds each time.
    const cues = subtitleIndex === null
      ? []
      : yield* Effect.tap(
        ffmpeg.extractCues(absolute, subtitleIndex),
        (loaded) => Console.log(`loaded ${loaded.length} subtitle cues`)
      )

    const ladder = Ladder.build({
      sourceHeight: video.height ?? 1080,
      sourceBitrate: Number(video.bit_rate) || null,
      canCopy: canStreamCopy(video)
    })
    const startIndex = Ladder.startingIndex(ladder)

    const startingRung = yield* Option.match(Array.get(ladder, startIndex), {
      onNone: () => Effect.fail(new EmptyLadderError()),
      onSome: (rung) => Effect.succeed(rung)
    })

    const state = yield* Ref.make<SessionState>({
      offsetSeconds: seek,
      rung: startingRung,
      cues
    })

    const target = yield* resolveDevice(
      ip,
      device,
      config.devicePort,
      config.discoveryTimeout
    )
    const advertise = yield* localAddress(config.advertiseHost)
    const baseUrl = `http://${advertise}:${config.port}`

    // Where the viewer actually is, tracked from the receiver's own reports so
    // a reload resumes rather than restarting the film.
    const position = yield* Ref.make(seek)

    // A rung change has to re-issue LOAD: the receiver is already streaming, so
    // updating the state alone would never reach it. The controller publishes
    // the change and a fiber below performs the reload, which keeps the two
    // from having to know about each other.
    const reloads = yield* Queue.unbounded<Rung>()

    const controller = yield* Quality.make({
      ladder,
      initialIndex: startIndex,
      onSwitch: (rung) => Queue.offer(reloads, rung)
    })

    // Serve on every interface; only the advertised URL has to be right.
    const server = HttpRouter.serve(
      routes({
        file: absolute,
        videoIndex: StreamIndex.make(video.index),
        audioIndex,
        audioBitrate: config.audioBitrate,
        state,
        onBytes: controller.noteBytes
      })
    ).pipe(Layer.provide(HttpServerPlatform.layer(config.port)))

    // Built into the enclosing scope rather than launched in a forked fiber:
    // acquisition *is* the bind, so this returns only once the port is
    // accepting. Forking it raced the LOAD below — the receiver was handed a
    // URL for a server that had not started listening yet, and simply did
    // nothing.
    yield* Layer.build(server)
    yield* Effect.forkScoped(controller.run)

    const sendLoad = Effect.fn("cast.sendLoad")(function*(session: CastSession.Session) {
      const current = yield* Ref.get(state)
      // No metadata.title: the Default Media Receiver pins it as a permanent
      // overlay across the video, sitting on top of the subtitles.
      // Built through the schema rather than as a loose object literal: the
      // literal sets are closed, so a typo in `streamType` or a track missing
      // its mandatory `language` is a compile error instead of a receiver
      // silently declining to show subtitles.
      const media = new Media.MediaInformation({
        contentId: `${baseUrl}/stream?o=${current.offsetSeconds}`,
        contentType: "video/mp4",
        streamType: "BUFFERED",
        ...(subtitleIndex === null ? {} : {
          tracks: [
            new Media.Track({
              trackId: SUBTITLE_TRACK_ID,
              type: "TEXT",
              subtype: "SUBTITLES",
              trackContentId: `${baseUrl}/subs.vtt?o=${current.offsetSeconds}`,
              trackContentType: "text/vtt",
              language: subtitleLanguage,
              name: `Subtitles (${subtitleLanguage})`
            })
          ]
        })
      })
      // Clear any previous text track first, or the receiver keeps its already
      // rendered cues painted on screen and draws the new ones above them.
      yield* Effect.when(
        session.mediaCommand("EDIT_TRACKS_INFO", { activeTrackIds: [] }),
        Effect.succeed(subtitleIndex !== null)
      )
      yield* session.load(media, subtitleIndex === null ? [] : [SUBTITLE_TRACK_ID])
      yield* controller.noteRestart
    })

    yield* Console.log(
      `\n  file     ${path.basename(absolute)}` +
        `\n  video    ${video.codec_name} ${video.width}x${video.height}` +
        `\n  quality  adaptive — ${ladder.map(describeRung).join(" | ")}` +
        `\n  serving  ${baseUrl}/stream` +
        `\n  device   ${target.name} (${target.ip}:${target.port})\n`
    )

    // One attempt at a session: connect, load, and pump status until the socket
    // drops. Returning normally would end the film, so a closed stream is a
    // typed failure and the retry below rebuilds everything.
    const runSession = Effect.gen(function*() {
      const session = yield* CastSession.make(target.ip, target.port)
      yield* session.launch
      yield* sendLoad(session)

      // A rejected LOAD is otherwise indistinguishable from a slow start.
      yield* Effect.forkScoped(
        Stream.runForEach(session.loadFailures, (failure) =>
          Console.error(
            `\n  the receiver rejected the stream: ${failure.detail}\n` +
              "  try a different --audio stream, or check `cast streams` for the track indices"
          ))
      )

      yield* Effect.forkScoped(
        Stream.runForEach(Stream.fromQueue(reloads), (rung) =>
          Effect.gen(function*() {
            const at = yield* Ref.get(position)
            yield* Ref.update(state, (current) => ({
              ...current,
              rung,
              offsetSeconds: at
            }))
            yield* sendLoad(session)
          }))
      )

      yield* Stream.runForEach(session.statuses, (status) =>
        Effect.gen(function*() {
          yield* controller.noteState(status.playerState)
          // The receiver reports time within the *current* stream, which starts
          // at the offset we last loaded from.
          const current = yield* Ref.get(state)
          yield* Ref.set(
            position,
            Seconds.make(current.offsetSeconds + status.currentTimeSeconds)
          )
        }))

      return yield* Effect.fail(new ConnectionLostError())
    })

    yield* runSession.pipe(
      Effect.tapError(() =>
        Effect.gen(function*() {
          const at = yield* Ref.get(position)
          yield* Console.log(`\n  connection lost — reconnecting at ${TimeCode.format(at)}…`)
          yield* Ref.update(state, (current) => ({ ...current, offsetSeconds: at }))
          yield* controller.noteRestart
        })
      ),
      // Backoff, capped: a device that has gone to sleep should be retried
      // patiently, not hammered.
      // Steady, bounded retries: a device that has gone to sleep should be
      // retried patiently rather than hammered.
      Effect.retry(
        Schedule.spaced(Duration.seconds(3)).pipe(Schedule.upTo({ times: 30 }))
      )
    )
  })
).pipe(Command.withDescription("Stream a file to a Cast device"))

// ---------------------------------------------------------------- streams

const streams = Command.make(
  "streams",
  { file: Argument.string("file").pipe(Argument.withDescription("Path to the media file")) },
  Effect.fn(function*({ file }) {
    const ffmpeg = yield* Ffmpeg
    const info = yield* ffmpeg.probe(path.resolve(file))
    yield* Effect.forEach(info.streams, (stream) =>
      Console.log(
        `  [${stream.index}] ${stream.codec_type.padEnd(8)} ${stream.codec_name ?? "?"} ` +
          `${stream.language}${stream.channels === undefined ? "" : ` ${stream.channels}ch`}` +
          `${stream.tags?.title === undefined ? "" : ` "${stream.tags.title}"`}`
      ), { discard: true })
  })
).pipe(
  Command.withDescription("List the audio, video and subtitle tracks in a file"),
  Command.withExamples([
    { command: "cast streams movie.mkv", description: "Find the audio and subtitle stream indices" }
  ])
)

// ------------------------------------------------------------------- root

const cast = Command.make("cast").pipe(
  Command.withDescription("Stream local media to a Cast device"),
  Command.withSubcommands([play, scan, streams, ...Control.all])
)

// Ffmpeg depends on ChildProcessSpawner, so its layer is *composed* over the
// platform layer rather than merged beside it.
const MainLayer = Layer.mergeAll(
  Ffmpeg.layer.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer
)

cast.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.scoped,
  Effect.provide(MainLayer),
  NodeRuntime.runMain
)
