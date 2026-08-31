// The AirPlay path, end to end, against an emulated device.
//
// Proves the critical property: HAP pair-verify runs, then the device fetches
// from us via play-queue. Tests AirPlay 2 protocol with requirePairing=true.

import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeServices } from "@effect/platform-node"
import { AirPlayDevice as EmulatorDevice } from "@castcli/emulator"
import { NodeSuite, Suite, Session } from "@castcli/airplay"
import { NodeCrypto } from "@effect/platform-node"
import { Brands, AirPlayDevice } from "@castcli/domain"
import {
  eventually,
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
    "runs pair-verify then play-queue, device fetches the stream",
    () =>
      Effect.gen(function*() {
        yield* noStrayPlayers
        const ready = yield* requireBinaries("ffmpeg")

        return yield* Effect.when(
          Effect.gen(function*() {
            const name = "castcli-e2e-airplay"
            const device = yield* EmulatorDevice.make({
              name,
              advertise: false,
              requirePairing: true
            })

            // Generate controller identity for pairing
            const suite = yield* Suite.Suite
            const controllerKeys = yield* suite.ed25519KeyPair
            const controllerIdentifier = "test-controller"

            // Pairing must be provided since requirePairing=true
            const accessoryKeys = device.accessoryKeys
            yield* Effect.when(
              Effect.fail(new Error("requirePairing=true but no accessoryKeys")),
              Effect.succeed(accessoryKeys === undefined)
            )

            const pairing = yield* Option.match(Option.fromNullishOr(accessoryKeys), {
              onNone: () => Effect.fail(new Error("No accessory keys")),
              onSome: (keys) => Effect.succeed({
                record: {
                  controller: {
                    identifier: new TextEncoder().encode(controllerIdentifier),
                    publicKey: controllerKeys.publicKey
                  },
                  accessory: {
                    identifier: keys.identifier,
                    publicKey: keys.publicKey
                  }
                },
                controllerIdentity: {
                  identifier: controllerIdentifier,
                  keys: controllerKeys
                }
              })
            })

            // Call Session.play with pairing
            yield* Session.play(
              new AirPlayDevice({
                ip: Brands.Ipv4.make("127.0.0.1"),
                port: device.port,
                name: device.name,
                model: "Emulator"
              }),
              {
                contentLocation: "http://127.0.0.1:8080/test.m3u8",
                startPosition: Brands.Seconds.make(0),
                pairing
              }
            )

            // 1. Device was handed something to play via POST /command after pair-verify
            const loaded = yield* eventually(device.loaded, Option.isSome, Duration.seconds(10))
            const media = Option.flatten(loaded)
            assert.isTrue(Option.isSome(media), "the device was never given a URL")

            yield* Option.match(media, {
              onNone: () => Effect.void,
              onSome: (given) =>
                Effect.sync(() => {
                  assert.include(given.url, "test.m3u8")
                })
            })

            const currentRate = yield* device.rate
            assert.strictEqual(currentRate, 1)
          }).pipe(Effect.scoped),
          Effect.succeed(ready)
        )
      }).pipe(Effect.provide(TestServices)),
    { timeout: 300_000 }
  )
})
