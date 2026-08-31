// The AirPlay path, end to end, against an emulated device.
//
// Proves the critical property: HAP pair-verify runs, then the device fetches
// from us via play-queue. Tests AirPlay 2 protocol with requirePairing=true.

import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option, Ref, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { FileSystem } from "effect/FileSystem"
import { NodeServices } from "@effect/platform-node"
import { AirPlayDevice as EmulatorDevice } from "@castcli/emulator"
import { NodeSuite } from "@castcli/airplay"
import { NodeCrypto } from "@effect/platform-node"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  eventually,
  makeSample,
  noStrayPlayers,
  play,
  requireBinaries
} from "./support/Fixture.ts"

const TestServices = Layer.mergeAll(
  FetchHttpClient.layer,
  NodeServices.layer,
  Layer.provide(NodeSuite, NodeCrypto.layer)
)

describe.skip("cast play, against an emulated AirPlay device", () => {
  // The emulator is a Node HTTP server. After pair-verify, Apple TV play-queue
  // wraps HTTP in HAP frames on the same TCP socket — hardware-proven on
  // Sala de estar. That framing is not HTTP, so these tests cannot complete
  // insertPlayQueueItem against the emulator. Un-skip when the emulator speaks HAP.

  it.live(
    "runs pair-setup then pair-verify then play-queue, device fetches the stream",
    () =>
      Effect.gen(function*() {
        yield* noStrayPlayers
        const ready = yield* requireBinaries("ffmpeg")

        return yield* Effect.when(
          Effect.gen(function*() {
            const fs = yield* FileSystem
            const directory = yield* fs.makeTempDirectoryScoped()
            const file = yield* makeSample()

            const name = "castcli-e2e-airplay"
            const device = yield* EmulatorDevice.make({
              name,
              advertise: false,
              requirePairing: true,
              requireAuthSetup: true
            })

            // Use the Fixture.play helper which forks the CLI and sets env vars correctly
            // Must specify --protocol airplay since --ip defaults to Cast
            yield* play(device, file, directory, ["--protocol", "airplay"])

            // 1. Device was handed something to play via POST /command after pair-setup and pair-verify
            const loaded = yield* eventually(device.loaded, Option.isSome, Duration.seconds(90))
            const media = Option.flatten(loaded)
            assert.isTrue(Option.isSome(media), "the device was never given a URL")

            yield* Option.match(media, {
              onNone: () => Effect.void,
              onSome: (given) =>
                Effect.sync(() => {
                  assert.include(given.url, "/stream")
                })
            })

            // 2. Device actually fetched the media (the key property)
            yield* eventually(
              device.fetched,
              (urls) => urls.some((url) => url.includes("/stream")),
              Duration.seconds(60)
            )

            const fetched = yield* device.fetched
            assert.isTrue(
              fetched.some((url) => url.includes("/stream")),
              `device did not fetch the media: ${fetched.join(", ")}`
            )

            const currentRate = yield* device.rate
            assert.strictEqual(currentRate, 1)
          }).pipe(Effect.scoped),
          Effect.succeed(ready)
        )
      }).pipe(Effect.provide(TestServices)),
    { timeout: 300_000 }
  )

  it.live(
    "discovers device via mDNS _airplay._tcp and plays content",
    () =>
      Effect.gen(function*() {
        yield* noStrayPlayers
        const ready = yield* requireBinaries("ffmpeg")

        return yield* Effect.when(
          Effect.gen(function*() {
            const fs = yield* FileSystem
            const directory = yield* fs.makeTempDirectoryScoped()
            const file = yield* makeSample()

            const name = "castcli-e2e-airplay-mdns"
            const device = yield* EmulatorDevice.make({
              name,
              advertise: true,
              requirePairing: true
            })

            // Capture CLI stdout/stderr
            const cliOutput = yield* Ref.make<string>("")
            const cliProcess = yield* Effect.flatMap(
              ChildProcessSpawner.ChildProcessSpawner,
              (spawner) =>
                spawner.spawn(
                  ChildProcess.make(
                    process.execPath,
                    ["dist/cast.cjs", "play", file, "--device", name],
                    {
                      forceKillAfter: "2 seconds",
                      extendEnv: true,
                      env: {
                        AIRPLAY_DEVICE_PORT: String(device.port),
                        CAST_ADVERTISE_HOST: "127.0.0.1",
                        XDG_STATE_HOME: directory,
                        AIRPLAY_PIN: "3939"
                      }
                    }
                  )
                )
            )

            // Collect stdout/stderr
            yield* Effect.forkScoped(
              Stream.runForEach(cliProcess.stdout, (chunk) =>
                Ref.update(cliOutput, (prev) => prev + new TextDecoder().decode(chunk))
              )
            )
            yield* Effect.forkScoped(
              Stream.runForEach(cliProcess.stderr, (chunk) =>
                Ref.update(cliOutput, (prev) => prev + new TextDecoder().decode(chunk))
              )
            )

            const loaded = yield* eventually(device.loaded, Option.isSome, Duration.seconds(90))
            const media = Option.flatten(loaded)
            
            yield* Effect.when(
              Effect.gen(function*() {
                const output = yield* Ref.get(cliOutput)
                yield* Effect.sync(() => {
                  assert.fail(`Device not found via mDNS. CLI output:\n${output}`)
                })
              }),
              Effect.succeed(Option.isNone(media))
            )
            
            assert.isTrue(Option.isSome(media), "the device was never found via mDNS or never given a URL")

            yield* Option.match(media, {
              onNone: () => Effect.void,
              onSome: (given) =>
                Effect.sync(() => {
                  assert.include(given.url, "/stream")
                })
            })

            yield* eventually(
              device.fetched,
              (urls) => urls.some((url) => url.includes("/stream")),
              Duration.seconds(90)
            )
            const fetched = yield* device.fetched
            assert.isTrue(
              fetched.some((url) => url.includes("/stream")),
              `device discovered via mDNS but never fetched content: ${fetched.join(", ")}`
            )
          }).pipe(Effect.scoped),
          Effect.succeed(ready)
        )
      }).pipe(Effect.provide(TestServices)),
    { timeout: 300_000 }
  )
})
