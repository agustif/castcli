// Control channel IPC end-to-end test.
//
// Tests that control commands (pause, status, seek) reach the running player
// through the unix socket control channel, proving that production IPC works.

import { assert, describe, it } from "@effect/vitest"
import {
  eventually,
  makeSample,
  noStrayPlayers,
  play,
  requireBinaries
} from "./support/Fixture.ts"
import { Duration, Effect, Layer, Option } from "effect"
import { FileSystem } from "effect/FileSystem"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeServices } from "@effect/platform-node"
import { DlnaDevice } from "@castcli/emulator"
import * as process from "node:process"

// Control channel tests do not need Certificate.layer - using DLNA device
const TestServices = Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)

describe("cast play control channel", () => {
  it.live(
    "talks to the running player via unix socket",
    () =>
      Effect.gen(function*() {
        yield* noStrayPlayers
        const ready = yield* requireBinaries("ffmpeg")

        return yield* Effect.when(
          Effect.gen(function*() {
            const fs = yield* FileSystem
            const directory = yield* fs.makeTempDirectoryScoped()
            const file = yield* makeSample()

            // DLNA device doesn't require TLS certificates
            const name = "castcli-control-channel-test"
            const device = yield* DlnaDevice.make({ friendlyName: name, advertise: true })

            // Control channel enabled (skipControlChannel = false), discover by name
            yield* play(device, file, directory, ["--device", name], true, false)

            // Wait for the device to start playing
            const loaded = yield* eventually(
              device.loaded,
              Option.isSome,
              Duration.seconds(90)
            )
            assert.isTrue(Option.isSome(Option.flatten(loaded)))

            // Test pause command - DLNA devices need device name, not IP
            const pauseExitCode = yield* Effect.flatMap(
              ChildProcessSpawner.ChildProcessSpawner,
              (spawner) =>
                Effect.scoped(
                  Effect.flatMap(
                    spawner.spawn(
                      ChildProcess.make(
                        process.execPath,
                        ["dist/cast.cjs", "pause", "--device", name],
                        {
                          extendEnv: true,
                          env: {
                            XDG_STATE_HOME: directory
                          }
                        }
                      )
                    ),
                    (handle) => handle.exitCode
                  )
                )
            )
            assert.strictEqual(pauseExitCode, 0, "pause command failed")

            // Test status command
            const statusExitCode = yield* Effect.flatMap(
              ChildProcessSpawner.ChildProcessSpawner,
              (spawner) =>
                Effect.scoped(
                  Effect.flatMap(
                    spawner.spawn(
                      ChildProcess.make(
                        process.execPath,
                        ["dist/cast.cjs", "status", "--device", name],
                        {
                          extendEnv: true,
                          env: {
                            XDG_STATE_HOME: directory
                          }
                        }
                      )
                    ),
                    (handle) => handle.exitCode
                  )
                )
            )
            assert.strictEqual(statusExitCode, 0, "status command failed")

            // Test seek command - this talks through control channel on progressive
            const seekExitCode = yield* Effect.flatMap(
              ChildProcessSpawner.ChildProcessSpawner,
              (spawner) =>
                Effect.scoped(
                  Effect.flatMap(
                    spawner.spawn(
                      ChildProcess.make(
                        process.execPath,
                        ["dist/cast.cjs", "seek", "--device", name, "--to", "0:05"],
                        {
                          extendEnv: true,
                          env: {
                            XDG_STATE_HOME: directory
                          }
                        }
                      )
                    ),
                    (handle) => handle.exitCode
                  )
                )
            )
            assert.strictEqual(seekExitCode, 0, "seek command failed")
          }).pipe(Effect.scoped),
          Effect.succeed(ready)
        )
      }).pipe(Effect.provide(TestServices)),
    { timeout: 300_000 }
  )
})
