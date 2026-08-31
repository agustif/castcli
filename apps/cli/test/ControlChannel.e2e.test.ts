// Control channel IPC end-to-end test.
//
// Tests that control commands (pause, status, seek) reach the running player
// through the unix socket control channel, proving that production IPC works.

import { assert, describe, it } from "@effect/vitest"
import {
  controlCommand,
  eventually,
  makeSample,
  noStrayPlayers,
  play,
  requireBinaries
} from "./support/Fixture.ts"
import { Duration, Effect, Layer, Option } from "effect"
import { FileSystem } from "effect/FileSystem"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeServices } from "@effect/platform-node"
import { DlnaDevice } from "@castcli/emulator"

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

            // Test pause command through the control channel
            const pauseExitCode = yield* controlCommand(device, directory, "pause", [])
            assert.strictEqual(pauseExitCode, 0, "pause command failed")

            // Test status command through the control channel
            const statusExitCode = yield* controlCommand(device, directory, "status", [])
            assert.strictEqual(statusExitCode, 0, "status command failed")

            // Test seek command through the control channel
            const seekExitCode = yield* controlCommand(device, directory, "seek", ["--to", "0:05"])
            assert.strictEqual(seekExitCode, 0, "seek command failed")
          }).pipe(Effect.scoped),
          Effect.succeed(ready)
        )
      }).pipe(Effect.provide(TestServices)),
    { timeout: 300_000 }
  )
})
