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
  Port,
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
  ServerBindError
} from "@castcli/domain"
import { CastDevice } from "@castcli/domain"
import { Mdns } from "@castcli/platform"
import { Controller as Quality } from "@castcli/quality"
import { Ladder } from "@castcli/quality"
import { Session as CastSession } from "@castcli/protocol"
import { Media } from "@castcli/protocol"
import { HttpServer as HttpServerPlatform } from "@castcli/platform"
import { routes, type SessionState } from "../Server/Routes.ts"
import * as State from "../State.ts"

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
const deviceAt = (address: Ipv4, devicePort: number) =>
  new CastDevice({ name: address, ip: address, port: Port.make(devicePort) })

const resolveDevice = (
  ip: Option.Option<Ipv4>,
  name: Option.Option<string>,
  devicePort: number,
  timeout: Duration.Duration
) =>
  Option.match(ip, {
    // An explicit address is obeyed exactly.
    onSome: (given) => Effect.succeed(deviceAt(given, devicePort)),
    onNone: () =>
      // A name has to be matched, so it always goes through discovery.
      // Otherwise the device from the last session is worth trying first: it
      // saves a four second sweep, and if it has gone stale — a different
      // network, a device that moved — discovery still runs, so the shortcut
      // can only save time.
      Option.isSome(name)
        ? discoverDevice(name, timeout)
        : Effect.flatMap(State.rememberedDevice, (last) =>
          Option.match(last, {
            onNone: () => discoverDevice(name, timeout),
            onSome: (known) => Effect.succeed(deviceAt(known, devicePort))
          }))
  })

/**
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
    hls: Flags.hls
  },
  Effect.fn(function*({ audio, device, file, hls, ip, seek, subs }) {
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
    // Saying so and carrying on beats refusing — the progressive path needs
    // neither.
    const useHls = hls && Option.isSome(duration) && hlsLadder.length > 0

    yield* Effect.when(
      Console.log("this file reports no duration, so HLS is not possible — streaming instead"),
      Effect.succeed(hls && Option.isNone(duration))
    )
    yield* Effect.when(
      Console.log(
        "this file is smaller than every encoded rung, so its only quality is a " +
          "stream copy, which cannot be segmented — streaming instead"
      ),
      Effect.succeed(hls && Option.isSome(duration) && hlsLadder.length === 0)
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

    const target = yield* resolveDevice(
      ip,
      device,
      config.devicePort,
      config.discoveryTimeout
    )
    yield* State.rememberDevice(target.ip)
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
        `\n  device   ${target.name} (${target.ip}:${target.port})\n`
    )

    // One attempt at a session: connect, load, and pump status until the socket
    // drops. Returning normally would end the film, so a closed stream is a
    // typed failure and the retry below rebuilds everything.
    // Whether a session has ever been established, which is what separates
    // "the TV is off" from "the TV dropped the connection".
    const everConnected = yield* Ref.make(false)

    // Seek requests already in the file belong to a previous run; only ones
    // newer than this are ours to act on.
    const lastSeekId = yield* Ref.make(
      Option.match(yield* State.pendingSeek, { onNone: () => 0, onSome: (request) => request.id })
    )

    const runSession = (castDevice: CastDevice) =>
      Effect.gen(function*() {
      const session = yield* CastSession.make(castDevice.ip, castDevice.port)
      yield* session.launch
      yield* Ref.set(everConnected, true)
      yield* sendLoad(session)

      // A rejected LOAD is otherwise indistinguishable from a slow start.
      yield* Effect.forkScoped(
        Stream.runForEach(session.loadFailures, (failure) =>
          Console.error(
            `\n  the receiver rejected the stream: ${failure.detail}\n` +
              "  try a different --audio stream, or check `cast streams` for the track indices"
          ))
      )

      // A seek asked for by `cast seek` that lands before this stream begins.
      // Polling a file is unglamorous, but the two processes share nothing
      // else, and the alternative — a socket of our own — is a great deal of
      // machinery for one integer.
      yield* Effect.forkScoped(
        Effect.repeat(
          Effect.gen(function*() {
            const requested = yield* State.pendingSeek
            yield* Option.match(requested, {
              onNone: () => Effect.void,
              onSome: (request) =>
                Effect.when(
                  Effect.gen(function*() {
                    yield* Ref.set(lastSeekId, request.id)
                    yield* Ref.set(position, request.toSeconds)
                    yield* Console.log(`\n  seeking to ${TimeCode.format(request.toSeconds)}…`)
                    yield* Queue.offer(reloads, (yield* Ref.get(state)).rung)
                  }),
                  Effect.map(Ref.get(lastSeekId), (seen) => request.id > seen)
                )
            })
          }),
          Schedule.spaced(Duration.seconds(1))
        )
      )

      // Reloading is how the progressive path changes quality. HLS has no use
      // for it — switching is the next segment — and the queue stays empty.
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
        schedule: Schedule.spaced(Duration.seconds(3)).pipe(Schedule.upTo({ times: 30 })),
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

    yield* attempt(target).pipe(
      // The remembered address is a shortcut, so it must not become a new way
      // to fail: a device that took a different lease is found by discovery,
      // not reported as switched off.
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
    )
  })
).pipe(Command.withDescription("Stream a file to a Cast device"))

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
  Command.withDescription("Stream local media to a Cast device"),
  Command.withSubcommands([play, scan, streams, ...Control.all])
)

// Ffmpeg depends on ChildProcessSpawner, so its layer is *composed* over the
// platform layer rather than merged beside it.
const MainLayer = Layer.mergeAll(
  Ffmpeg.layer.pipe(Layer.provide(NodeServices.layer)),
  State.Store.layer.pipe(Layer.provide(NodeServices.layer)),
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
    Console.error(`error: ${error.message.length > 0 ? error.message : error._tag}`)
  ),
  NodeRuntime.runMain({ disableErrorReporting: true })
)
