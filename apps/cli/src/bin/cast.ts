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
  Match,
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
import * as Target from "../Cli/Target.ts"
import { FetchHttpClient, HttpClient, HttpRouter, HttpBody, HttpClientRequest } from "effect/unstable/http"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { NodeCrypto } from "@effect/platform-node"
import { FileSystem } from "effect/FileSystem"
import * as os from "node:os"
import * as path from "node:path"

import { AppConfig } from "../Config.ts"
import { canStreamCopy, Ffmpeg, Hls, Tracks, Vtt } from "@castcli/media"
import {
  type AudioBitrate,
  describeRung,
  FilePath,
  type MediaStream,
  Height,
  Ipv4,
  type Rung,
  Seconds,
  StreamIndex,
  TrackId
} from "@castcli/domain"
import {
  ConnectionLostError,
  DeviceNotFoundError,
  EmptyLadderError,
  NoLocalAddressError,
  NoVideoStreamError,
  ServerBindError,
  AirPlayPinRequiredError
} from "@castcli/domain"
import { CastDevice } from "@castcli/domain"
import { Mdns } from "@castcli/platform"
import {
  Description as DlnaDescription,
  Renderer as DlnaRenderer
} from "@castcli/dlna"
import { Controller as Quality } from "@castcli/quality"
import { Ladder } from "@castcli/quality"
import { Session as CastSession } from "@castcli/protocol"
import { Media } from "@castcli/protocol"
import { HttpServer as HttpServerPlatform } from "@castcli/platform"
import { routes, type SessionState } from "../Server/Routes.ts"
import * as State from "../State.ts"
import * as ControlChannel from "../ControlChannel.ts"

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
    const client = yield* HttpClient.HttpClient
    yield* Console.log("scanning…")

    const found = yield* Target.discover(config.discoveryTimeout)

    yield* Effect.forEach(found.cast, (device) =>
      Console.log(
        `\n  ${device.name}\n    protocol  Cast` +
          `\n    address   ${device.address}` +
          `\n    model     ${device.model ?? "unknown"}` +
          `\n    status    ${device.status ?? "idle"}`
      ), { discard: true })

    yield* Effect.forEach(found.airplay, (device) =>
      Console.log(
        `\n  ${device.name}\n    protocol  AirPlay` +
          `\n    address   ${device.address}` +
          `\n    model     ${device.model ?? "unknown"}` +
          `\n    video     ${device.supportsVideo ? "yes" : "no"}`
      ), { discard: true })

    // A renderer's advertisement is only a pointer: what it is called, and
    // whether it can play video at all, live in the description at that URL.
    yield* Effect.forEach(found.upnp, (device) =>
      Effect.flatMap(
        Target.describeRenderer(client, device.location),
        Option.match({
          onNone: () => Effect.void,
          onSome: (renderer) =>
            Console.log(
              `\n  ${renderer.friendlyName}\n    protocol  DLNA` +
                `\n    address   ${new URL(device.location).host}` +
                `\n    model     ${Option.getOrElse(renderer.modelName, () => "unknown")}`
            )
        })
      ), { concurrency: 4, discard: true })

    yield* Effect.when(
      Console.log("none found — check the device is awake and on this network"),
      Effect.succeed(found.cast.length === 0 && found.upnp.length === 0 && found.airplay.length === 0)
    )
    yield* Effect.when(
      Effect.flatMap(
        localAddress(config.advertiseHost),
        (address) => Console.log(`\nlocal address to advertise: ${address}`)
      ),
      Effect.succeed(found.cast.length > 0 || found.upnp.length > 0 || found.airplay.length > 0)
    )
  })
).pipe(Command.withDescription("List devices on this network (Cast, DLNA, and AirPlay)"))

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
 * Play to a DLNA renderer and follow it until it stops.
 *
 * Much shorter than its Cast counterpart because UPnP asks less of a sender:
 * there is no application to launch, no connection to keep alive, and no
 * quality to manage — the device is handed a URL and told to play it.
 *
 * What it does not do is adapt. A renderer plays what it is given at the
 * bitrate it is given, so the quality ladder is not consulted here and the
 * stream is whatever the media server produces first.
 */
const playOnRenderer = Effect.fn("cast.playOnRenderer")(function*(options: {
  readonly renderer: DlnaDescription.Renderer
  readonly url: string
  readonly title: string
  readonly durationSeconds: Option.Option<Seconds>
  readonly subtitleUrl: Option.Option<string>
  readonly from: Seconds
  /**
   * Where the viewer has got to.
   *
   * Without this the position saved every fifteen seconds is the one playback
   * *started* at, so an hour of watching is remembered as none of it and the
   * film resumes at the beginning — which is worse than not remembering,
   * because it looks deliberate.
   */
  readonly onPosition: (at: Seconds) => Effect.Effect<void>
}) {
  const renderer = yield* DlnaRenderer.connect(options.renderer)

  yield* renderer.play({
    url: options.url,
    contentType: "video/mp4",
    title: options.title,
    durationSeconds: options.durationSeconds,
    subtitleUrl: options.subtitleUrl
  })

  // Seeking is a separate step: a renderer will not accept a position until it
  // has something loaded, and several answer 701 to a seek sent alongside the
  // URI. Resuming therefore means playing from the start and then moving,
  // which the viewer sees briefly.
  yield* Effect.when(
    renderer.seek(options.from).pipe(
      // Not fatal — the film is already playing, from the beginning — but not
      // silent either: a viewer who asked to resume and got the opening titles
      // deserves to know the device refused rather than that we forgot.
      Effect.catchCause((cause) =>
        Console.log(
          `  could not resume at ${TimeCode.format(options.from)}, playing from the start` +
            ` (${cause})`
        )
      )
    ),
    Effect.succeed(options.from > 0)
  )

  // There is no status stream to subscribe to — UPnP has no channel back — so
  // the position is polled. Once a second matches what the receiver-side
  // equivalent reports and is slow enough not to bother a television.
  //
  // The loop ends when the device says it has stopped, so `cast play` returns
  // when the film does instead of polling a finished television indefinitely.
  yield* Effect.repeat(
    Effect.flatMap(
      renderer.status,
      Option.match({
        onNone: () => Effect.succeed(false),
        onSome: (playback) =>
          Effect.as(
            Effect.andThen(
              // Only a position the device actually reported. `RelTime` is
              // legitimately `NOT_IMPLEMENTED` on some renderers, and writing a
              // fabricated zero to the resume point once a second would
              // continuously reset how far the viewer had got.
              Option.match(playback.position, {
                onNone: () => Effect.void,
                onSome: (at) => options.onPosition(at)
              }),
              Effect.logDebug(
                `${playback.state} at ${
                  Option.match(playback.position, {
                    onNone: () => "a position it does not report",
                    onSome: (at) => TimeCode.format(at)
                  })
                }`
              )
            ),
            playback.state === "STOPPED"
          )
      })
    ),
    { schedule: Schedule.spaced(Duration.seconds(1)), until: (stopped) => stopped }
  )
})

/**
 * Say which subtitle track was chosen/**
 * Say which subtitle track was chosen and, when there was a contest, what it
 * beat. The runner-up line is the point: it is how someone notices that the
 * track their container flags as `default` holds 24 cues of signage, without
 * having to extract anything themselves.
 */
const reportSubtitleChoice = (choice: Option.Option<Tracks.SubtitleChoice>) =>
  Option.match(choice, {
    onNone: () => Console.log("subtitles no matching track"),
    onSome: ({ considered, cues, stream }) =>
      Effect.andThen(
        Console.log(
          `subtitles stream ${stream.index} (${stream.language}), ${cues.length} cues`
        ),
        Effect.forEach(
          considered.filter((candidate) => candidate.stream.index !== stream.index),
          (runnerUp) =>
            Console.log(
              `          not stream ${runnerUp.stream.index} — ${runnerUp.cueCount} cues` +
                (runnerUp.stream.isDefault ? ", despite being flagged default" : "")
            ),
          { discard: true }
        )
      )
  })

/**
 * ffmpeg spells audio rates as `128k`; a playlist has to state them in bits per
 * second, because BANDWIDTH is what a receiver compares against its own
 * measurement.
 */
const bitsPerSecond = (rate: AudioBitrate): number =>
  Number.parseInt(rate, 10) * 1000

/**
 * Enough of a file's identity to know whether a cached answer still applies.
 *
 * Size and modification time rather than a hash: hashing a multi-gigabyte
 * container to save a few seconds of subtitle extraction would be a poor trade,
 * and a re-encode changes both.
 */
const fileFingerprint = Effect.fn("cast.fileFingerprint")(function*(file: FilePath) {
  const fs = yield* FileSystem
  const info = yield* fs.stat(file)
  return `${info.size}:${Option.getOrElse(info.mtime, () => new Date(0)).getTime()}`
})

/** The audio track in the summary block, or why there is none. */
const describeAudio = (chosen: Option.Option<MediaStream>): string =>
  Option.match(chosen, {
    onNone: () => "none",
    onSome: (stream) =>
      `stream ${stream.index} (${stream.language}) ${stream.codec_name ?? "unknown"}`
  })

const play = Command.make(
  "play",
  {
    file: Flags.mediaFile,
    device: Flags.deviceName,
    ip: Flags.deviceIp,
    audio: Flags.audioStream,
    subs: Flags.subtitleStream,
    seek: Flags.seek,
    progressive: Flags.progressive,
    pin: Flags.airplayPin,
    protocol: Flags.protocol
  },
  Effect.fn(function*({ audio, device, file, progressive, ip, seek, subs, pin, protocol }) {
    const config = yield* AppConfig
    const ffmpeg = yield* Ffmpeg
    // `Argument.file({ mustExist: true })` already proved it is there.
    const absolute = FilePath.make(path.resolve(file))

    const info = yield* ffmpeg.probe(absolute)

    // A file with no video stream is not something this tool can cast, and
    // `--streams` is a pure inspection that should never open a socket.
    const video = yield* Option.match(info.video, {
      onNone: () =>
        Effect.andThen(
          Console.error("no video stream in this file"),
          Effect.fail(new NoVideoStreamError({ path: absolute }))
        ),
      onSome: (found) => Effect.succeed(found)
    })

    // Chosen rather than demanded. An explicit flag always wins; otherwise the
    // language preferences decide, and for subtitles the cue count breaks ties
    // that the container's own flags get wrong. See packages/media/Tracks.
    const chosenAudio = Option.orElse(
      Option.flatMap(audio, (index) =>
        Array.findFirst(info.audioStreams, (stream) => stream.index === index)),
      () => Tracks.chooseAudio(info.audioStreams, config.audioLanguages)
    )
    const audioIndex = Option.flatMap(
      chosenAudio,
      (stream) => StreamIndex.makeOption(stream.index)
    )

    const chosenSubtitle = yield* Option.match(subs, {
      // An explicit --subs skips the survey: the person has already decided,
      // and extracting the alternatives would cost seconds to learn nothing.
      onSome: (index) =>
        Effect.map(
          ffmpeg.extractCues(absolute, index),
          (cues) =>
            Option.map(
              Array.findFirst(info.subtitleStreams, (stream) => stream.index === index),
              (stream): Tracks.SubtitleChoice => ({ stream, cues, considered: [] })
            )
        ),
      onNone: () =>
        Tracks.chooseSubtitle(absolute, info.subtitleStreams, config.subtitleLanguages)
    })

    yield* reportSubtitleChoice(chosenSubtitle)

    const subtitleIndex = Option.flatMap(
      chosenSubtitle,
      (choice) => StreamIndex.makeOption(choice.stream.index)
    )
    // RFC 5646 tag. Mandatory when the subtype is SUBTITLES — a track without
    // one is ignored by the receiver without any error.
    const subtitleLanguage = Option.getOrElse(
      Option.map(chosenSubtitle, (choice) => choice.stream.language),
      () => "und"
    )
    // Extracted once up front rather than per request: a Cast receiver handed a
    // slowly-arriving text track stacks cues on screen instead of replacing
    // them, and re-running ffmpeg per seek costs seconds each time.
    const cues = Option.match(chosenSubtitle, {
      onNone: () => [],
      onSome: (choice): Vtt.Cues => choice.cues
    })

    const ladder = Ladder.build({
      // ffprobe omits either field for some containers; the schema already
      // decoded them, so absence is the only thing left to handle.
      sourceHeight: Option.getOrElse(
        Option.flatMap(Option.fromNullishOr(video.height), (h) => Height.makeOption(h)),
        () => Height.make(1080)
      ),
      sourceBitrate: Option.fromNullishOr(video.bit_rate),
      canCopy: canStreamCopy(video)
    })
    const startIndex = Ladder.startingIndex(ladder)

    // HLS is arithmetic over the running time, so a container that does not
    // report one cannot be presented that way at all. Saying so and carrying on
    // beats refusing: the progressive path needs no duration.
    const duration = info.durationSeconds

    const hlsLadder = Hls.variantsFor(ladder)
    // HLS needs two things this file may not have: a duration to compute the
    // playlist from, and at least one variant that can be cut into segments.
    // When HLS is impossible or explicitly disabled, fall back to progressive.
    const useHls = !progressive && Option.isSome(duration) && hlsLadder.length > 0

    yield* Effect.when(
      Console.log("this file reports no duration, so HLS is not possible — using progressive instead"),
      Effect.succeed(!progressive && Option.isNone(duration))
    )
    yield* Effect.when(
      Console.log(
        "this file is smaller than every encoded rung, so its only quality is a " +
          "stream copy, which cannot be segmented — using progressive instead"
      ),
      Effect.succeed(!progressive && Option.isSome(duration) && hlsLadder.length === 0)
    )

    const startingRung = yield* Option.match(Array.get(ladder, startIndex), {
      onNone: () => Effect.fail(new EmptyLadderError()),
      onSome: (rung) => Effect.succeed(rung)
    })

    // Resume where this file was left, unless a position was asked for. The
    // remembered position is the reason `--seek` is rarely needed twice.
    const resumed = yield* Option.match(seek, {
      onSome: (at) => Effect.succeed(at),
      onNone: () =>
        Effect.flatMap(State.positionOf(absolute), (remembered) =>
          Option.match(remembered, {
            onNone: () => Effect.succeed(Seconds.make(0)),
            onSome: (at) =>
              Effect.as(
                Console.log(`resuming  ${TimeCode.format(at)} (pass --seek 0 to start over)`),
                at
              )
          }))
    })

    const state = yield* Ref.make<SessionState>({
      offsetSeconds: resumed,
      rung: startingRung,
      cues
    })

    const target = yield* Target.resolve({
      ip,
      name: device,
      devicePort: config.devicePort,
      airplayPort: config.airplayPort,
      timeout: config.discoveryTimeout,
      protocol
    })

    // Only a Cast address is worth remembering. A DLNA renderer is reached
    // through a description URL that its own advertisement supplies, and
    // caching that would cache a port the device is free to change on reboot.
    yield* Match.value(target).pipe(
      Match.tag("Cast", ({ device: found }) => State.rememberDevice(found.ip)),
      // The name, not the description URL: a description lives on a port the
      // device re-picks when it reboots, and the URL carries no identity — a
      // remembered one points at nothing, or at whatever else has since been
      // given that port. A name survives a reboot and costs the SSDP sweep that
      // discovery would have cost anyway.
      //
      // Recorded here as well as by the control commands, or the first `pause`
      // after playing to a renderer has no memory of the protocol and sweeps
      // both networks preferring Cast — which a Chromecast on the same network
      // will happily answer.
      Match.tag("Dlna", ({ renderer }) => State.rememberRenderer(renderer.friendlyName)),
      Match.tag("AirPlay", ({ device: found }) => State.rememberAirPlay(found.ip)),
      Match.exhaustive
    )
    const advertise = yield* localAddress(config.advertiseHost)

    // Where the viewer actually is, tracked from the receiver's own reports so
    // a reload resumes rather than restarting the film.
    const position = yield* Ref.make(resumed)

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
    const serverOn = (port: number) =>
      HttpRouter.serve(
        routes({
          file: absolute,
          durationSeconds: Option.getOrElse(duration, () => Seconds.make(0)),
          videoIndex: StreamIndex.make(video.index),
          audioIndex,
          audioBitrate: config.audioBitrate,
          audioBitsPerSecond: bitsPerSecond(config.audioBitrate),
          ladder: hlsLadder,
          state,
          onBytes: controller.noteBytes
        })
      ).pipe(Layer.provide(HttpServerPlatform.layer(port)))

    // Built into the enclosing scope rather than launched in a forked fiber:
    // acquisition *is* the bind, so this returns only once the port is
    // accepting. Forking it raced the LOAD below — the receiver was handed a
    // URL for a server that had not started listening yet, and simply did
    // nothing.
    //
    // The configured port is a preference rather than a requirement: the
    // receiver is told which URL to pull, so any free port serves just as well.
    // Falling back to an ephemeral one means a port already taken — by another
    // cast, or by some unrelated program that happens to like 8021 — stops
    // being a reason to refuse to play a film.
    const servingPort = yield* Layer.build(serverOn(config.port)).pipe(
      Effect.as(config.port),
      Effect.catchTag("ServeError", () =>
        Effect.gen(function*() {
          const fallback = yield* HttpServerPlatform.freePort
          yield* Console.log(`port ${config.port} is taken; serving on ${fallback} instead`)
          yield* Layer.build(serverOn(fallback)).pipe(
            Effect.catchTag(
              "ServeError",
              (cause) => Effect.fail(new ServerBindError({ port: config.port, cause }))
            )
          )
          return fallback
        }))
    )

    const baseUrl = `http://${advertise}:${servingPort}`

    // Under HLS the receiver chooses the quality from its own buffer, so
    // running the controller as well means two parties deciding: it would
    // measure the segment fetches, decide to switch, and reissue LOAD —
    // restarting the film to overrule a receiver that was managing fine.
    // The controller and reload queue only run in progressive mode.
    yield* Effect.when(Effect.forkScoped(controller.run), Effect.succeed(!useHls))

    const sendLoad = Effect.fn("cast.sendLoad")(function*(session: CastSession.Session) {
      const current = yield* Ref.get(state)
      // No metadata.title: the Default Media Receiver pins it as a permanent
      // overlay across the video, sitting on top of the subtitles.
      // Built through the schema rather than as a loose object literal: the
      // literal sets are closed, so a typo in `streamType` or a track missing
      // its mandatory `language` is a compile error instead of a receiver
      // silently declining to show subtitles.
      // The two presentations differ only here. Under HLS the receiver is
      // handed a master playlist covering the whole film, so it seeks and
      // switches quality by itself and the offset moves from the URL into
      // LOAD's own `currentTime`. Progressively, the offset *is* the stream:
      // ffmpeg starts there and the receiver has nothing to seek within.
      const presentation = useHls
        ? {
          contentId: `${baseUrl}/master.m3u8`,
          contentType: Hls.CONTENT_TYPE,
          // Lowercase on the wire, whatever the sender-side documentation
          // says — taken from the receiver framework Google ships.
          hlsSegmentFormat: "ts_aac" as const,
          duration: Option.getOrElse(duration, () => Seconds.make(0))
        }
        : {
          contentId: `${baseUrl}/stream?o=${current.offsetSeconds}`,
          contentType: "video/mp4"
        }

      const media = new Media.MediaInformation({
        ...presentation,
        streamType: "BUFFERED",
        ...(Option.isNone(subtitleIndex) ? {} : {
          tracks: [
            new Media.Track({
              trackId: SUBTITLE_TRACK_ID,
              type: "TEXT",
              subtype: "SUBTITLES",
              // Under HLS the receiver seeks for itself, so the cues have to
              // cover the whole film rather than start at the offset.
              trackContentId: `${baseUrl}/subs.vtt?o=${useHls ? 0 : current.offsetSeconds}`,
              trackContentType: "text/vtt",
              language: subtitleLanguage,
              name: `Subtitles (${subtitleLanguage})`
            })
          ]
        })
      })
      // Clear any previous text track first, or the receiver keeps its already
      // rendered cues painted on screen and draws the new ones above them.
      //
      // On the *first* load there is no media session yet and so nothing to
      // clear, which the session now reports rather than silently ignoring.
      // That is the right default — a control command that vanishes is worse
      // than one that fails — but here it genuinely means "nothing to do".
      yield* Effect.when(
        session.mediaCommand(CastSession.MediaCommand.EDIT_TRACKS_INFO({ activeTrackIds: [] }))
          .pipe(Effect.catchTag("CastProtocolError", () => Effect.void)),
        Effect.succeed(Option.isSome(subtitleIndex))
      )
      yield* session.load(
        media,
        Option.isNone(subtitleIndex) ? [] : [SUBTITLE_TRACK_ID],
        // Where to begin. Only meaningful under HLS: progressively the stream
        // itself starts at the offset, so asking to start anywhere but zero
        // would skip that much again.
        useHls ? Option.some(current.offsetSeconds) : Option.none()
      )
      // What `cast seek` needs, and it needs both halves: where this stream
      // begins, because the receiver reports time relative to it, and whether
      // the receiver can seek at all — under HLS it can, progressively the
      // player has to restart ffmpeg instead.
      yield* State.setActive(
        Option.some(
          new State.ActiveStream({
            file: absolute,
            offsetSeconds: useHls ? Seconds.make(0) : current.offsetSeconds,
            seekable: useHls
          })
        )
      )
      yield* controller.noteRestart
    })

    yield* Console.log(
      `\n  file     ${path.basename(absolute)}` +
        `\n  video    ${video.codec_name} ${video.width}x${video.height}` +
        `\n  audio    ${describeAudio(chosenAudio)}` +
        `\n  quality  adaptive — ${ladder.map(describeRung).join(" | ")}` +
        `\n  serving  ${baseUrl}/stream` +
        `\n  device   ${Target.describe(target)}\n`
    )

    // One attempt at a session: connect, load, and pump status until the socket
    // drops. Returning normally would end the film, so a closed stream is a
    // typed failure and the retry below rebuilds everything.
    // Whether a session has ever been established, which is what separates
    // "the TV is off" from "the TV dropped the connection".
    const everConnected = yield* Ref.make(false)

    // Ref to hold the current session for control commands. Updated on each
    // connection attempt so control commands reach the active session.
    const currentSession = yield* Ref.make<Option.Option<CastSession.Session>>(Option.none())

    // The control channel handles seek/pause/resume/stop commands from other
    // processes. Started once for the entire play command, not per retry.
    // Only in progressive mode does seek mean "restart ffmpeg at a new offset"
    // — under HLS the receiver seeks itself.
    //
    // Skip control channel in test environment to avoid blocking issues.
    // In production, if the control channel fails to start, log a warning and continue.
    // eslint-disable-next-line castcli/no-process-env
    const shutdownControl = process.env["SKIP_CONTROL_CHANNEL"]
      ? yield* Effect.succeed(Effect.void)
      : yield* ControlChannel.startServer({
          onSeek: (to) =>
            Effect.when(
              Effect.gen(function*() {
                yield* Ref.set(position, to)
                yield* Console.log(`\n  seeking to ${TimeCode.format(to)}…`)
                yield* Queue.offer(reloads, (yield* Ref.get(state)).rung)
              }),
              Effect.succeed(!useHls)
            ),
          onPause: Effect.flatMap(Ref.get(currentSession), (session) =>
            Option.match(session, {
              onNone: () => Effect.void,
              onSome: (s) => s.mediaCommand(CastSession.MediaCommand.PAUSE()).pipe(
                Effect.orElseSucceed(() => undefined)
              )
            })
          ),
          onResume: Effect.flatMap(Ref.get(currentSession), (session) =>
            Option.match(session, {
              onNone: () => Effect.void,
              onSome: (s) => s.mediaCommand(CastSession.MediaCommand.PLAY()).pipe(
                Effect.orElseSucceed(() => undefined)
              )
            })
          ),
          onStop: Effect.flatMap(Ref.get(currentSession), (session) =>
            Option.match(session, {
              onNone: () => Effect.void,
              onSome: (s) => s.stopReceiver
            })
          ),
          getStatus: Effect.map(Ref.get(position), (at) =>
            Option.some({
              file: absolute,
              offsetSeconds: at,
              seekable: useHls
            })
          )
        }).pipe(
          Effect.tapError((error) =>
            Console.warn(`\nControl channel unavailable: ${error}\nPlayback will continue but pause/seek commands won't work.\n`)
          ),
          Effect.orElseSucceed(() => Effect.void)
        )

    // Ensure the control server shuts down when play ends
    yield* Effect.addFinalizer(() => shutdownControl)

    const runSession = (castDevice: CastDevice) =>
      Effect.gen(function*() {
        const session = yield* CastSession.make(castDevice.ip, castDevice.port)
        yield* session.launch
        yield* Ref.set(everConnected, true)
        yield* Ref.set(currentSession, Option.some(session))
        yield* sendLoad(session)

        // A rejected LOAD is otherwise indistinguishable from a slow start.
        yield* Effect.forkScoped(
          Stream.runForEach(session.loadFailures, (failure) =>
            Console.error(
              `\n  the receiver rejected the stream: ${failure.detail}\n` +
                "  try a different --audio stream, or check `cast streams` for the track indices"
            ))
        )


        // Reloading is how the progressive path changes quality. HLS has no use
        // for it — switching is the next segment — and the queue stays empty.
        // This fiber is only forked when !useHls, so the queue is only used
        // in progressive mode.
        yield* Effect.when(
          Effect.forkScoped(
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
          ),
          Effect.succeed(!useHls)
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

    // Saved on a timer rather than per status report: the receiver sends one a
    // second, and a bookmark does not need that resolution.
    yield* Effect.forkScoped(
      Effect.repeat(
        Effect.flatMap(Ref.get(position), (at) => State.rememberPosition(absolute, at)),
        Schedule.spaced(Duration.seconds(15))
      )
    )

    const attempt = (castDevice: CastDevice) =>
      runSession(castDevice).pipe(
      Effect.tapError(() =>
        Effect.gen(function*() {
          const at = yield* Ref.get(position)
          // Only announce a reconnection that is actually going to be
          // attempted: saying "reconnecting" and then giving up reads as a
          // second, unexplained failure.
          yield* Effect.when(
            Console.log(`\n  connection lost — reconnecting at ${TimeCode.format(at)}…`),
            Ref.get(everConnected)
          )
          yield* Ref.update(state, (current) => ({ ...current, offsetSeconds: at }))
          yield* controller.noteRestart
        })
      ),
      // Steady, bounded retries: a device that has gone to sleep mid-film
      // should be waited for patiently rather than hammered.
      //
      // But a device that never answered at all is a different situation, and
      // retrying it for ninety seconds buries the one useful line — that it is
      // off — under thirty repetitions of "connection lost". So reconnection is
      // for sessions that existed: once one has, an unreachable device is worth
      // waiting for; before that, it is worth reporting.
      Effect.retry({
        // Exponential with jitter rather than a fixed three seconds thirty
        // times: a device that is rebooting is back in seconds, one that has
        // been switched off is not coming back at all, and hammering a sleeping
        // television at a fixed rate serves neither. Jitter matters because
        // several senders reconnecting in lockstep is how a receiver gets
        // knocked over again just as it recovers.
        schedule: Schedule.exponential(Duration.seconds(1), 2).pipe(
          Schedule.jittered,
          Schedule.upTo({ duration: Duration.minutes(2) })
        ),
        while: (error) =>
          Effect.map(
            Ref.get(everConnected),
            (connected) => connected || error._tag === "ConnectionLostError"
          )
      }),
      // After the retries, not inside them: however this ends — the film
      // finishing, the device going away, a Ctrl-C — the last known position is
      // worth keeping, and the active stream is not, because nothing is playing
      // any more. Inside the retry this would clear the active stream during
      // every transient reconnect.
      Effect.ensuring(
        Effect.gen(function*() {
          yield* State.rememberPosition(absolute, yield* Ref.get(position))
          yield* State.setActive(Option.none())
        })
      )
      )

    // The one place the three protocols diverge. Everything above — probing the
    // file, choosing the tracks, extracting the subtitles, serving the media —
    // is the same work, because all three are pull models and the device does the
    // fetching either way.
    yield* Match.value(target).pipe(
      Match.tag("Cast", ({ device: castDevice }) =>
        attempt(castDevice).pipe(
          // The remembered address is a shortcut, so it must not become a new
          // way to fail: a device that took a different lease is found by
          // discovery, not reported as switched off.
          Option.isSome(ip)
            ? (self) => self
            : Effect.catchTag(
              "DeviceUnreachableError",
              () =>
                Effect.flatMap(
                  Effect.tap(
                    discoverDevice(device, config.discoveryTimeout),
                    (found) => State.rememberDevice(found.ip)
                  ),
                  attempt
                )
            )
        )),
      Match.tag("Dlna", ({ renderer }) =>
        Effect.andThen(
          // What `cast seek` reads to turn a position in the film into one
          // within the track we served. The URL carries `?o=${resumed}`, so a
          // seek that assumed the track began at zero would be wrong by exactly
          // the resume offset — invisible on a fresh play and confusing on a
          // part-watched one. `seekable` because a renderer is handed a plain
          // URL with byte ranges, and seeks it natively.
          State.setActive(
            Option.some(
              new State.ActiveStream({
                file: absolute,
                offsetSeconds: resumed,
                seekable: true
              })
            )
          ),
          playOnRenderer({
          renderer,
          url: `${baseUrl}/stream?o=${resumed}`,
          title: path.basename(absolute),
          durationSeconds: duration,
          // SubRip rather than WebVTT: the metadata handed to a renderer
          // advertises `text/srt`, which is what the Samsung and LG firmware
          // reads, and a set given WebVTT there fetches it and silently shows
          // nothing.
          subtitleUrl: Option.map(
            subtitleIndex,
            () => `${baseUrl}/subs.srt?o=${resumed}`
          ),
            from: resumed,
            onPosition: (at) => Ref.set(position, at)
          })
        )),
      Match.tag("AirPlay", ({ device: airplayDevice }) =>
        Effect.andThen(
          State.setActive(
            Option.some(
              new State.ActiveStream({
                file: absolute,
                offsetSeconds: resumed,
                seekable: true
              })
            )
          ),
          Effect.gen(function*() {
            const AirPlay = yield* Effect.promise(() => import("@castcli/airplay"))
            const { Redacted } = yield* Effect.promise(() => import("effect"))
            const { Session: AirPlaySession, PairSetup, Suite, NodeSuite } = AirPlay
            const deviceIp = Ipv4.make(airplayDevice.ip)
            const deviceId = Option.fromNullishOr(airplayDevice.deviceId)

            const storedPairing = yield* State.getAirPlayPairing(deviceIp, deviceId)

            const pairing = yield* Option.match(storedPairing, {
              onNone: () => Effect.gen(function*() {
                const pairingPin = Option.orElse(pin, () => config.airplayPin)
                return yield* Option.match(pairingPin, {
                  onNone: () => Effect.fail(new AirPlayPinRequiredError()),
                  onSome: (pinValue) => Effect.gen(function*() {
                    const suite = yield* Effect.provide(Suite.Suite, Layer.provide(NodeSuite, NodeCrypto.layer))
                    const identity = yield* Effect.gen(function*() {
                      const keys = yield* suite.ed25519KeyPair
                      const id = yield* Effect.sync(() => crypto.randomUUID())
                      return { identifier: id, keys }
                    }).pipe(Effect.provide(Layer.provide(NodeSuite, NodeCrypto.layer)))

                    const m1Bytes = yield* PairSetup.m1({ flags: [] })
                    const client = yield* HttpClient.HttpClient
                    const pairSetupUrl = `http://${airplayDevice.ip}:${airplayDevice.port}/pair-setup`

                    const m2Response = yield* client.execute(
                      HttpClientRequest.post(pairSetupUrl, { body: HttpBody.uint8Array(m1Bytes) })
                    ).pipe(Effect.flatMap((r) => r.arrayBuffer), Effect.map((buf) => new Uint8Array(buf)))

                    const { request: m3Bytes, state: proved } = yield* PairSetup.m3(m2Response, { pin: pinValue }).pipe(
                      Effect.provide(Layer.provide(NodeSuite, NodeCrypto.layer))
                    )
                    const m4Response = yield* client.execute(
                      HttpClientRequest.post(pairSetupUrl, { body: HttpBody.uint8Array(m3Bytes) })
                    ).pipe(Effect.flatMap((r) => r.arrayBuffer), Effect.map((buf) => new Uint8Array(buf)))

                    const { request: m5Bytes, state: exchanged } = yield* PairSetup.m5(m4Response, { state: proved, identity }).pipe(
                      Effect.provide(Layer.provide(NodeSuite, NodeCrypto.layer))
                    )
                    const m6Response = yield* client.execute(
                      HttpClientRequest.post(pairSetupUrl, { body: HttpBody.uint8Array(m5Bytes) })
                    ).pipe(Effect.flatMap((r) => r.arrayBuffer), Effect.map((buf) => new Uint8Array(buf)))

                    const pairSetupResult = yield* PairSetup.finish(m6Response, exchanged).pipe(
                      Effect.provide(Layer.provide(NodeSuite, NodeCrypto.layer))
                    )

                    const revealedValue = Redacted.value(identity.keys.privateKey)
                    const privateKeyBytes = new Uint8Array(revealedValue.buffer ?? revealedValue)

                    const newPairing = new State.AirPlayPairing({
                      deviceIp,
                      ...(Option.isSome(deviceId) ? { deviceId: Option.getOrThrow(deviceId) } : {}),
                      controllerIdentifier: identity.identifier,
                      controllerPublicKey: identity.keys.publicKey,
                      controllerPrivateKey: privateKeyBytes,
                      accessoryIdentifier: pairSetupResult.accessory.identifier,
                      accessoryPublicKey: pairSetupResult.accessory.publicKey
                    })

                    yield* State.storeAirPlayPairing(newPairing)
                    return newPairing
                  })
                })
              }),
              onSome: (existing) => Effect.succeed(existing)
            })

            const url = useHls ? `${baseUrl}/master.m3u8` : `${baseUrl}/stream?o=${resumed}`
            yield* AirPlaySession.play(airplayDevice, {
              contentLocation: url,
              startPosition: useHls ? Seconds.make(0) : resumed,
              pairing: {
                record: {
                  controller: {
                    identifier: new TextEncoder().encode(pairing.controllerIdentifier),
                    publicKey: pairing.controllerPublicKey
                  },
                  accessory: {
                    identifier: pairing.accessoryIdentifier,
                    publicKey: pairing.accessoryPublicKey
                  }
                },
                controllerIdentity: {
                  identifier: pairing.controllerIdentifier,
                  keys: {
                    publicKey: pairing.controllerPublicKey,
                    privateKey: Redacted.make(pairing.controllerPrivateKey)
                  }
                }
              }
            }).pipe(Effect.provide(NodeSuite))
            yield* Console.log(`playing on ${airplayDevice.name}`)
          })
        )),
      Match.exhaustive
    )
  })
).pipe(Command.withDescription("Stream a file to a device (Cast, DLNA, or AirPlay)"))

// ---------------------------------------------------------------- streams

/** `default`/`forced`, and only when set — an empty listing is easier to read. */
const describeDisposition = (stream: MediaStream): string =>
  [
    ...(stream.isDefault ? ["default"] : []),
    ...(stream.isForced ? ["forced"] : [])
  ].join(" ")

const streams = Command.make(
  "streams",
  { file: Argument.string("file").pipe(Argument.withDescription("Path to the media file")) },
  Effect.fn(function*({ file }) {
    const config = yield* AppConfig
    const ffmpeg = yield* Ffmpeg
    const absolute = FilePath.make(path.resolve(file))
    const info = yield* ffmpeg.probe(absolute)

    // Cue counts are the reason this command exists in its current form: two
    // subtitle tracks of the same language are otherwise indistinguishable, and
    // the container's own flags point at the wrong one.
    //
    // Counting means extracting each track, which is seconds apiece — so it
    // happens concurrently, only for subtitles, and only once per file. The
    // fingerprint is size and modification time, so the answer is reused until
    // the file itself changes.
    const fingerprint = yield* fileFingerprint(absolute)
    const cached = yield* State.cachedCueCounts(absolute, fingerprint)

    const cuesByIndex = yield* Option.match(cached, {
      onSome: (known) =>
        Effect.succeed(
          new Map(
            Object.entries(known.counts).map(([index, count]) => [Number(index), count] as const)
          )
        ),
      onNone: () =>
        Effect.gen(function*() {
          yield* Effect.when(
            Console.log("reading the subtitle tracks (once per file)…"),
            Effect.succeed(info.subtitleStreams.length > 0)
          )
          const counted = yield* Effect.forEach(
            info.subtitleStreams,
            (stream) =>
              Effect.map(
                ffmpeg.extractCues(absolute, StreamIndex.make(stream.index)),
                (cues) => [stream.index, cues.length] as const
              ),
            { concurrency: 4 }
          )
          yield* State.rememberCueCounts(
            absolute,
            fingerprint,
            Object.fromEntries(counted.map(([index, count]) => [String(index), count]))
          )
          return new Map(counted)
        })
    })

    // Marked with the same functions `play` uses, so the listing answers "what
    // will it do" rather than merely "what is in the file".
    const wouldPlay = new Set(
      [
        ...Option.match(Tracks.chooseAudio(info.audioStreams, config.audioLanguages), {
          onNone: () => [],
          onSome: (stream) => [stream.index]
        }),
        ...Option.match(
          Tracks.bestSubtitle(info.subtitleStreams, config.subtitleLanguages, cuesByIndex),
          { onNone: () => [], onSome: (stream) => [stream.index] }
        )
      ]
    )

    yield* Effect.forEach(info.streams, (stream) =>
      Console.log(
        `  ${wouldPlay.has(stream.index) ? "->" : "  "} ` +
          `[${stream.index}] ${stream.codec_type.padEnd(8)} ${stream.codec_name ?? "?"} ` +
          `${stream.language}${stream.channels === undefined ? "" : ` ${stream.channels}ch`}` +
          `${
            Option.match(Option.fromNullishOr(cuesByIndex.get(stream.index)), {
              onNone: () => "",
              onSome: (count) => ` ${count} cues`
            })
          }` +
          `${describeDisposition(stream) === "" ? "" : ` [${describeDisposition(stream)}]`}` +
          `${Option.match(stream.title, { onNone: () => "", onSome: (title) => ` "${title}"` })}`
      ), { discard: true })

    yield* Effect.when(
      Console.log("\n  -> is what `cast play` would choose with your current language preferences"),
      Effect.succeed(wouldPlay.size > 0)
    )
  })
).pipe(
  Command.withDescription("List the audio, video and subtitle tracks in a file"),
  Command.withExamples([
    { command: "cast streams movie.mkv", description: "Find the audio and subtitle stream indices" }
  ])
)

// ------------------------------------------------------------------- root

const cast = Command.make("cast").pipe(
  Command.withDescription("Stream local media to a device (Cast, DLNA, or AirPlay)"),
  Command.withSubcommands([play, scan, streams, ...Control.all])
)

// Ffmpeg depends on ChildProcessSpawner, so its layer is *composed* over the
// platform layer rather than merged beside it.
const MainLayer = Layer.mergeAll(
  Ffmpeg.layer.pipe(Layer.provide(NodeServices.layer)),
  State.Store.layer.pipe(Layer.provide(NodeServices.layer)),
  // DLNA is request-response over HTTP: fetching a device's description and
  // posting SOAP at it both need a client, where Cast needs only a socket.
  FetchHttpClient.layer,
  NodeServices.layer
)

cast.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.scoped,
  Effect.provide(MainLayer),
  // Every expected failure is a domain error that renders itself, so the
  // message is the useful part and the stack trace is noise — "the TV is off"
  // does not need thirty frames of Effect internals. The failure still
  // propagates, so the exit code stays non-zero.
  //
  // Falling back to the tag matters: an Effect built-in error can carry an
  // empty message, and `error:` followed by nothing tells a person less than no
  // output at all would.
  Effect.tapError((error) =>
    Console.error(
      `error: ${Match.value(error).pipe(
        Match.when(Match.string, (s) => s.length > 0 ? s : "unknown"),
        Match.when({ _tag: Match.string, message: Match.string }, (e) => 
          e.message.length > 0 ? e.message : e._tag
        ),
        Match.when({ _tag: Match.string }, (e) => e._tag),
        Match.orElse(() => "unknown")
      )}`
    )
  ),
  NodeRuntime.runMain({ disableErrorReporting: true })
)
