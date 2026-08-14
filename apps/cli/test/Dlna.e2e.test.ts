// The DLNA path, end to end, against a television that is not one.
//
// The Cast equivalent of this test proved the thing that matters about casting:
// the device fetches from us. The same is true here and is worth proving
// separately, because everything underneath differs — SOAP posted at a URL
// instead of protobuf over TLS, a description document instead of an
// application launch, and discovery by SSDP instead of mDNS.
//
// What is shared is the half above the transport: probing the file, choosing
// the tracks, and serving the media. That is the claim this test checks.

import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option } from "effect"
import { FileSystem } from "effect/FileSystem"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeServices } from "@effect/platform-node"
import { DlnaDevice } from "@castcli/emulator"
import {
  eventually,
  makeSample,
  noStrayPlayers,
  play,
  requireBinaries
} from "./support/Fixture.ts"

const TestServices = Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)

describe("cast play, against an emulated DLNA renderer", () => {
  // `it.live`, not `it.effect`: the latter supplies a TestClock whose time never
  // advances, and everything here waits on real processes and real sockets.
  it.live(
    "finds a renderer over SSDP and gets it to pull the film",
    () =>
      Effect.gen(function*() {
        yield* noStrayPlayers
        const ready = yield* requireBinaries("ffmpeg")

        return yield* Effect.when(
          Effect.gen(function*() {
            const fs = yield* FileSystem
            const directory = yield* fs.makeTempDirectoryScoped()
            const file = yield* makeSample()

            // Advertising is off by default for good reason, so a test that
            // wants to be discovered has to ask. The address handed out is
            // loopback, so nothing beyond this machine can reach it.
            const name = "castcli-e2e-renderer"
            const device = yield* DlnaDevice.make({ friendlyName: name, advertise: true })

            yield* play(device, file, directory, ["--device", name], true)

            // 1. Found by name over SSDP, its description fetched and read, and
            //    handed something to play.
            const loaded = yield* eventually(device.loaded, Option.isSome, Duration.seconds(90))
            const media = Option.flatten(loaded)
            assert.isTrue(Option.isSome(media), "the renderer was never given a URI")

            yield* Option.match(media, {
              onNone: () => Effect.void,
              onSome: (given) =>
                Effect.sync(() => {
                  assert.include(given.uri, "/stream")
                  // The metadata is not decoration: several televisions play
                  // nothing at all when handed a bare URL, and most of the rest
                  // show no title and no seek bar without it.
                  assert.include(given.metadata, "object.item.videoItem")
                  assert.include(given.metadata, "protocolInfo")
                })
            })

            // 2. It really pulled. Setting the URI starts nothing — a device
            //    left there sits on a black screen — so this also proves the
            //    Play that has to follow it was sent.
            yield* eventually(
              device.fetched,
              (urls) => urls.some((url) => url.includes("/stream")),
              Duration.seconds(90)
            )
            const fetched = yield* device.fetched
            assert.isTrue(
              fetched.some((url) => url.includes("/stream")),
              `the renderer never pulled the stream: ${fetched.join(", ")}`
            )

            const state = yield* device.transportState
            assert.strictEqual(state, "PLAYING")
          }).pipe(Effect.scoped),
          // openssl is not needed here: DLNA is plain HTTP, and only the Cast
          // device has a TLS listener to present a certificate for.
          Effect.succeed(ready)
        )
      }).pipe(Effect.provide(TestServices)),
    { timeout: 300_000 }
  )
})
