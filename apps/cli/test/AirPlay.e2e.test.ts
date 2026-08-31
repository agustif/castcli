// The AirPlay path, end to end, against an emulated device.
//
// Proves the critical property: HAP pair-verify runs, then the device fetches
// from us via play-queue. Tests AirPlay 2 protocol with requirePairing=true.

import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { FileSystem } from "effect/FileSystem"
import { NodeServices } from "@effect/platform-node"
import { AirPlayDevice as EmulatorDevice } from "@castcli/emulator"
import { NodeSuite } from "@castcli/airplay"
import { NodeCrypto } from "@effect/platform-node"
import {
  eventually,
  makeSample,
  noStrayPlayers,
  requireBinaries
} from "./support/Fixture.ts"

const TestServices = Layer.mergeAll(
  FetchHttpClient.layer,
  NodeServices.layer,
  Layer.provide(NodeSuite, NodeCrypto.layer)
)

describe("cast play, against an emulated AirPlay device", () => {
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
              requirePairing: true
            })

            // Import ChildProcessSpawner to run the CLI
            const { ChildProcess, ChildProcessSpawner } = yield* Effect.promise(() =>
              import("effect/unstable/process")
            )
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const process = yield* Effect.promise(() => import("node:process"))

            // Run: cast play --ip 127.0.0.1 FILE with AIRPLAY_DEVICE_PORT env var
            // The CLI forks, so we don't wait for its exit code (it's long-running)
            yield* Effect.scoped(
              Effect.flatMap(
                spawner.spawn(
                  ChildProcess.make(
                    process.execPath,
                    [
                      "dist/cast.cjs",
                      "play",
                      "--ip",
                      "127.0.0.1",
                      file
                    ],
                    {
                      extendEnv: true,
                      env: {
                        XDG_STATE_HOME: directory,
                        AIRPLAY_DEVICE_PORT: `${device.port}`
                      }
                    }
                  )
                ),
                (handle) => handle.exitCode
              )
            )

            // 1. Device was handed something to play via POST /command after pair-setup and pair-verify
            const loaded = yield* eventually(device.loaded, Option.isSome, Duration.seconds(90))
            const media = Option.flatten(loaded)
            assert.isTrue(Option.isSome(media), "the device was never given a URL")

            yield* Option.match(media, {
              onNone: () => Effect.void,
              onSome: (given) =>
                Effect.sync(() => {
                  assert.include(given.url, "master.m3u8")
                })
            })

            // 2. Device actually fetched the media (the key property)
            yield* eventually(
              device.fetched,
              (urls) => urls.some((url) => url.includes("/master.m3u8")),
              Duration.seconds(60)
            )

            const fetched = yield* device.fetched
            assert.isTrue(
              fetched.some((url) => url.includes("/master.m3u8")),
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
})
