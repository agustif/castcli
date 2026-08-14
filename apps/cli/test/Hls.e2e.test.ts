// The whole thing, end to end, against a device that is not a television.
//
// This runs the real `cast play` binary at an emulated Cast device and checks
// what the device actually pulled. It is the only test that exercises the
// inversion this tool is built around — the receiver fetches from us — and so
// the only one that can catch a playlist a receiver would refuse or a segment
// URL that leads nowhere.
//
// It needs ffmpeg and openssl, so it skips rather than fails where they are
// absent. That is a deliberate trade: a suite that will not run without a media
// pipeline installed is a suite people stop running.

import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option, Schedule } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { NodeServices } from "@effect/platform-node"
import * as process from "node:process"
import { FetchHttpClient } from "effect/unstable/http"
import { Certificate, Device } from "@castcli/emulator"

const hasBinary = (name: string) =>
  Effect.map(
    Effect.exit(
      Effect.flatMap(
        ChildProcessSpawner.ChildProcessSpawner,
        (spawner) => spawner.string(ChildProcess.make(name, ["-version"]))
      )
    ),
    (exit) => exit._tag === "Success"
  )

/**
 * A test film: picture, sound and a subtitle track.
 *
 * Cached under `node_modules/.cache` and reused, because generating it is real
 * ffmpeg work and three tests in this file want the same thing — it was most of
 * what the file spent its time on. The name carries a version so a change to
 * what is generated does not quietly reuse the old one.
 *
 * Fifteen seconds is three HLS segments: enough for a playlist with several
 * entries and a variant switch to be possible, and no longer than that.
 *
 * The subtitles matter — they are served as a side-loaded WebVTT track rather
 * than inside the presentation, and whether a receiver fetches that when handed
 * an HLS master playlist is the kind of thing only a device can answer.
 */
const SAMPLE_VERSION = 2

const makeSample = Effect.fn("test.makeSample")(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem
  const path = yield* Path

  const directory = path.join("node_modules", ".cache", "castcli")
  const file = path.join(directory, `sample-v${SAMPLE_VERSION}.mkv`)
  yield* fs.makeDirectory(directory, { recursive: true })

  const exists = yield* Effect.orElseSucceed(fs.exists(file), () => false)

  return yield* Effect.when(
    Effect.gen(function*() {
      const subtitles = path.join(directory, `sample-v${SAMPLE_VERSION}.srt`)
      yield* fs.writeFileString(
        subtitles,
        "1\n00:00:01,000 --> 00:00:04,000\nfirst line\n\n" +
          "2\n00:00:06,000 --> 00:00:09,000\nsecond line\n\n" +
          "3\n00:00:11,000 --> 00:00:14,000\nthird line\n"
      )

      // One pass rather than two: `-shortest` is what forced a second mux, and
      // giving each input an explicit duration removes the need for it.
      yield* spawner.string(
        ChildProcess.make("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=640x360:rate=25:duration=15",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=15",
          "-i",
          subtitles,
          "-map",
          "0:v",
          "-map",
          "1:a",
          "-map",
          "2:s",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-g",
          "50",
          "-c:a",
          "aac",
          "-c:s",
          "copy",
          "-metadata:s:s:0",
          "language=eng",
          file
        ])
      )
    }),
    Effect.succeed(!exists)
  ).pipe(Effect.as(file))
})

/**
 * Poll until a condition holds, or give up.
 *
 * Generous timeouts on purpose: this spawns `npx tsx` and encodes video while
 * the rest of the suite runs alongside it, and a flake here would be blamed on
 * the code rather than on a loaded machine. They have to sum to less than the
 * test's own timeout, or the last wait is the one that fails and the message
 * says nothing about which step was slow.
 */
const eventually = <A>(
  effect: Effect.Effect<A>,
  holds: (value: A) => boolean,
  timeout: Duration.Duration
) =>
  Effect.timeoutOption(
    Effect.repeat(effect, {
      schedule: Schedule.spaced(Duration.millis(250)),
      until: holds
    }),
    timeout
  )

const TestServices = Layer.mergeAll(
  Certificate.Certificate.layer.pipe(Layer.provide(NodeServices.layer)),
  // The emulated device is an HTTP *client* — pulling is what a receiver does.
  FetchHttpClient.layer,
  NodeServices.layer
)

/** Run the real binary at the emulator, exactly as a person would run it. */
const play = (
  device: { readonly port: number },
  file: string,
  stateDirectory: string,
  extra: ReadonlyArray<string>,
  /** Omit `--ip` so the player has to find the device for itself. */
  byDiscovery = false
) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    Effect.forkScoped(
      Effect.scoped(
        Effect.flatMap(
          spawner.spawn(
            // The bundle, not the sources through tsx: it starts in 0.1s where
            // tsx takes 0.7s, and it is what `npm i -g` installs — so this
            // tests what people actually run. `npm run test:e2e` builds it.
            //
            // One process, too. `npx tsx` spawns tsx which spawns node, and
            // killing the top of that tree orphans the bottom: nine stray
            // players accumulated across runs before that was noticed, holding
            // ports and CPU until the suite starved.
            ChildProcess.make(
              process.execPath,
              [
                "dist/cast.cjs",
                "play",
                file,
                ...(byDiscovery ? [] : ["--ip", "127.0.0.1"]),
                ...extra
              ],
              {
                extendEnv: true,
                env: {
                  CAST_DEVICE_PORT: String(device.port),
                  CAST_ADVERTISE_HOST: "127.0.0.1",
                  XDG_STATE_HOME: stateDirectory
                }
              }
            )
          ),
          (handle) =>
            // Killed when the scope closes, whatever the fiber was doing. The
            // player never exits on its own — that is the point of it.
            Effect.andThen(
              Effect.addFinalizer(() => Effect.orElseSucceed(handle.kill(), () => undefined)),
              Effect.andThen(handle.exitCode, Effect.void)
            )
        )
      )
    ))

describe("cast play, against an emulated device", () => {
  // `it.live`, not `it.effect`: the latter supplies a TestClock, so the polling
  // below would wait on a clock that never advances. This test is about real
  // processes taking real time.
  it.live(
    "serves HLS the receiver can actually walk",
    () =>
      Effect.gen(function*() {
        const ffmpeg = yield* hasBinary("ffmpeg")
        const openssl = yield* hasBinary("openssl")

        return yield* Effect.when(
          Effect.gen(function*() {
            const fs = yield* FileSystem
            const directory = yield* fs.makeTempDirectoryScoped()
            const file = yield* makeSample()

            const device = yield* Device.make({ segments: 2 })

            yield* play(device, file, directory, ["--hls"])

            // 1. The device was handed an HLS presentation.
            const loaded = yield* eventually(
              device.loaded,
              Option.isSome,
              Duration.seconds(90)
            )
            const media = Option.flatten(loaded)
            assert.isTrue(Option.isSome(media), "the device was never sent a LOAD")

            yield* Option.match(media, {
              onNone: () => Effect.void,
              onSome: (info) =>
                Effect.sync(() => {
                  assert.include(info.contentId, "/master.m3u8")
                  assert.strictEqual(info.contentType, "application/x-mpegurl")
                  // Lowercase on the wire, whatever the sender documentation says.
                  assert.deepStrictEqual(info.hlsSegmentFormat, Option.some("ts_aac"))
                })
            })

            // 2. It walked the playlists and pulled real segments. This is the
            //    half that a test of what we *sent* cannot reach.
            yield* eventually(
              device.fetched,
              (urls) => urls.some((url) => url.endsWith(".ts")),
              Duration.seconds(60)
            )

            const fetched = yield* device.fetched
            assert.isTrue(
              fetched.some((url) => url.endsWith("/master.m3u8")),
              `no master playlist was fetched: ${fetched.join(", ")}`
            )
            assert.isTrue(
              fetched.some((url) => /\/v\d+\.m3u8$/.test(url)),
              `no variant playlist was fetched: ${fetched.join(", ")}`
            )
            assert.isTrue(
              fetched.some((url) => /\/v\d+\/\d+\.ts$/.test(url)),
              `no segment was fetched: ${fetched.join(", ")}`
            )

            // 3. Segments came back with content rather than an error page.
            const segments = fetched.filter((url) => url.endsWith(".ts"))
            assert.isAtLeast(segments.length, 1)

            // 4. Seeking is what HLS is for: under it the receiver seeks
            //    itself, so `cast seek` sends SEEK rather than asking the
            //    player to restart ffmpeg. Progressively this same command
            //    reloads instead, which is the distinction worth pinning.
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            yield* Effect.scoped(
              Effect.flatMap(
                spawner.spawn(
                  ChildProcess.make(
                    process.execPath,
                    ["dist/cast.cjs", "seek", "--to", "0:12"],
                    {
                      extendEnv: true,
                      env: {
                        CAST_DEVICE_PORT: String(device.port),
                        XDG_STATE_HOME: directory
                      }
                    }
                  )
                ),
                (handle) => handle.exitCode
              )
            )

            yield* eventually(
              device.playback,
              (state) => state._tag === "Playing" && state.at === 12,
              Duration.seconds(30)
            )
            const playback = yield* device.playback
            assert.strictEqual(playback._tag, "Playing")
            assert.strictEqual(
              playback._tag === "Playing" ? playback.at : -1,
              12,
              "the device did not seek where it was told"
            )

            // 5. The subtitle track is side-loaded rather than part of the
            //    presentation, so it has to be fetched separately — and under
            //    HLS it must cover the whole film, not start at an offset.
            yield* eventually(
              device.fetched,
              (urls) => urls.some((url) => url.includes("/subs.vtt")),
              Duration.seconds(30)
            )
            const subtitleUrl = (yield* device.fetched).find((url) => url.includes("/subs.vtt"))
            assert.isDefined(subtitleUrl, "the device never fetched the subtitle track")
            assert.include(subtitleUrl ?? "", "o=0")
          }).pipe(Effect.scoped),
          Effect.succeed(ffmpeg && openssl)
        )
      }).pipe(Effect.provide(TestServices)),
    { timeout: 300_000 }
  )

  it.live(
    "still serves the progressive stream, which the receiver pulls whole",
    () =>
      Effect.gen(function*() {
        const ffmpeg = yield* hasBinary("ffmpeg")
        const openssl = yield* hasBinary("openssl")

        return yield* Effect.when(
          Effect.gen(function*() {
            const fs = yield* FileSystem
            const directory = yield* fs.makeTempDirectoryScoped()
            const file = yield* makeSample()

            const device = yield* Device.make()
            yield* play(device, file, directory, [])

            const loaded = yield* eventually(device.loaded, Option.isSome, Duration.seconds(90))

            yield* Option.match(Option.flatten(loaded), {
              onNone: () => Effect.sync(() => assert.fail("the device was never sent a LOAD")),
              onSome: (info) =>
                Effect.sync(() => {
                  // The offset lives in the URL here, because the stream itself
                  // starts there — there is nothing to seek within.
                  assert.include(info.contentId, "/stream?o=")
                  assert.strictEqual(info.contentType, "video/mp4")
                  assert.isTrue(Option.isNone(info.hlsSegmentFormat))
                })
            })

            yield* eventually(
              device.fetched,
              (urls) => urls.some((url) => url.includes("/stream")),
              Duration.seconds(60)
            )
            const fetched = yield* device.fetched
            assert.isTrue(
              fetched.some((url) => url.includes("/stream")),
              `the device never pulled the stream: ${fetched.join(", ")}`
            )
          }).pipe(Effect.scoped),
          Effect.succeed(ffmpeg && openssl)
        )
      }).pipe(Effect.provide(TestServices)),
    { timeout: 300_000 }
  )

  it.live(
    "can be found rather than told where it is",
    () =>
      Effect.gen(function*() {
        const ffmpeg = yield* hasBinary("ffmpeg")
        const openssl = yield* hasBinary("openssl")

        return yield* Effect.when(
          Effect.gen(function*() {
            const fs = yield* FileSystem
            const directory = yield* fs.makeTempDirectoryScoped()
            const file = yield* makeSample()

            // Discovery is the path a person actually uses — nobody types
            // --ip unless something has gone wrong — and it was the one part
            // of this tool an emulated device could not exercise, because the
            // device had no way to announce itself.
            const name = "castcli-e2e-device"
            const device = yield* Device.make({
              segments: 1,
              advertise: { friendlyName: name, model: "EmulatedForTests" }
            })

            yield* play(device, file, directory, ["--device", name, "--hls"], true)

            const loaded = yield* eventually(device.loaded, Option.isSome, Duration.seconds(90))
            assert.isTrue(
              Option.isSome(Option.flatten(loaded)),
              "the player never found the device by name"
            )

            // Found by name, and then actually reachable at the address and
            // port the advertisement carried.
            yield* eventually(
              device.fetched,
              (urls) => urls.some((url) => url.includes(".m3u8")),
              Duration.seconds(90)
            )
            assert.isTrue((yield* device.fetched).length > 0)
          }).pipe(Effect.scoped),
          Effect.succeed(ffmpeg && openssl)
        )
      }).pipe(Effect.provide(TestServices)),
    { timeout: 300_000 }
  )
})
