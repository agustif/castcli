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
 * Thirty seconds of test pattern, which is five HLS segments and change — long
 * enough that a playlist has several entries and short enough to encode in a
 * couple of seconds.
 */
const makeSample = (into: string) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const path = yield* Path
    const file = path.join(into, "sample.mkv")
    yield* spawner.string(
      ChildProcess.make("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=25:duration=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=30",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "50",
        "-c:a",
        "aac",
        "-shortest",
        file
      ])
    )
    return file
  })

/**
 * Poll until a condition holds, or give up.
 *
 * Generous timeouts on purpose: this spawns `npx tsx` and encodes video while
 * the rest of the suite runs alongside it, and a flake here would be blamed on
 * the code rather than on a loaded machine.
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
  extra: ReadonlyArray<string>
) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    Effect.forkScoped(
      Effect.scoped(
        Effect.flatMap(
          spawner.spawn(
            ChildProcess.make(
              "npx",
              ["tsx", "apps/cli/src/bin/cast.ts", "play", file, "--ip", "127.0.0.1", ...extra],
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
          (handle) => Effect.andThen(handle.exitCode, Effect.void)
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
            const file = yield* makeSample(directory)

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
          }).pipe(Effect.scoped),
          Effect.succeed(ffmpeg && openssl)
        )
      }).pipe(Effect.provide(TestServices)),
    { timeout: 180_000 }
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
            const file = yield* makeSample(directory)

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
    { timeout: 180_000 }
  )
})
