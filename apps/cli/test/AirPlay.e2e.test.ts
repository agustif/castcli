// The AirPlay path, end to end, against an emulated device.
//
// Proves the critical property: the device fetches from us. Same as the DLNA
// test but for AirPlay discovery and endpoints.

import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option } from "effect"
import { FileSystem } from "effect/FileSystem"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeServices } from "@effect/platform-node"
import { AirPlayDevice } from "@castcli/emulator"
import {
  eventually,
  makeSample,
  noStrayPlayers,
  play,
  requireBinaries
} from "./support/Fixture.ts"

const TestServices = Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)

describe("cast play, against an emulated AirPlay device", () => {
  it.live(
    "finds an AirPlay device over mDNS and gets it to pull the film",
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
            const device = yield* AirPlayDevice.make({ name, advertise: true })

            // Give the mDNS advertisement time to propagate
            yield* Effect.sleep(Duration.seconds(2))

            yield* play(device, file, directory, ["--device", name], true)

            // 1. Found by name over mDNS and handed something to play
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

            // 2. It really pulled. The device fetches the URL it was given.
            yield* eventually(
              device.fetched,
              (urls) => urls.some((url) => url.includes("/stream")),
              Duration.seconds(90)
            )
            const fetched = yield* device.fetched
            assert.isTrue(
              fetched.some((url) => url.includes("/stream")),
              `the device never pulled the stream: ${fetched.join(", ")}`
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
