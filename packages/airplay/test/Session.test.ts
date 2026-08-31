import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeServices } from "@effect/platform-node"
import { AirPlayDevice, Brands } from "@castcli/domain"
import * as Emulator from "@castcli/emulator"
import * as Session from "../src/Session.ts"

const TestLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  NodeServices.layer
)

describe("AirPlay Session", () => {
  describe("setVolume", () => {
    it.effect("sets device volume", () =>
      Effect.gen(function*() {
        const device = yield* Emulator.AirPlayDevice.make()
        const airplayDevice = new AirPlayDevice({
          name: device.name,
          ip: Brands.Ipv4.make("127.0.0.1"),
          port: device.port
        })

        const level = Brands.VolumeLevel.make(0.75)
        yield* Session.setVolume(airplayDevice, level)

        const currentVolume = yield* device.volume
        assert.strictEqual(currentVolume, 0.75)
      }).pipe(Effect.provide(TestLayer), Effect.scoped))

    it.effect("accepts minimum volume", () =>
      Effect.gen(function*() {
        const device = yield* Emulator.AirPlayDevice.make()
        const airplayDevice = new AirPlayDevice({
          name: device.name,
          ip: Brands.Ipv4.make("127.0.0.1"),
          port: device.port
        })

        const level = Brands.VolumeLevel.make(0)
        yield* Session.setVolume(airplayDevice, level)

        const currentVolume = yield* device.volume
        assert.strictEqual(currentVolume, 0)
      }).pipe(Effect.provide(TestLayer), Effect.scoped))

    it.effect("accepts maximum volume", () =>
      Effect.gen(function*() {
        const device = yield* Emulator.AirPlayDevice.make()
        const airplayDevice = new AirPlayDevice({
          name: device.name,
          ip: Brands.Ipv4.make("127.0.0.1"),
          port: device.port
        })

        const level = Brands.VolumeLevel.make(1)
        yield* Session.setVolume(airplayDevice, level)

        const currentVolume = yield* device.volume
        assert.strictEqual(currentVolume, 1)
      }).pipe(Effect.provide(TestLayer), Effect.scoped))
  })

  describe("playbackInfo", () => {
    it.effect("decodes playback-info from emulator", () =>
      Effect.gen(function*() {
        const device = yield* Emulator.AirPlayDevice.make()
        const airplayDevice = new AirPlayDevice({
          name: device.name,
          ip: Brands.Ipv4.make("127.0.0.1"),
          port: device.port
        })

        const info = yield* Session.playbackInfo(airplayDevice)

        assert.ok(Option.isSome(info))
        const value = Option.getOrThrow(info)
        assert.strictEqual(value.duration, 0)
        assert.strictEqual(value.position, 0)
        assert.strictEqual(value.rate, 1)
        assert.strictEqual(value.readyToPlay, true)
      }).pipe(Effect.provide(TestLayer), Effect.scoped))

    it.effect("decodes position after scrub", () =>
      Effect.gen(function*() {
        const device = yield* Emulator.AirPlayDevice.make()
        const airplayDevice = new AirPlayDevice({
          name: device.name,
          ip: Brands.Ipv4.make("127.0.0.1"),
          port: device.port
        })

        yield* Session.scrub(airplayDevice, Brands.Seconds.make(42.5))

        const info = yield* Session.playbackInfo(airplayDevice)
        assert.ok(Option.isSome(info))
        const value = Option.getOrThrow(info)
        assert.strictEqual(value.position, 42.5)
      }).pipe(Effect.provide(TestLayer), Effect.scoped))

    it.effect("decodes rate after pause", () =>
      Effect.gen(function*() {
        const device = yield* Emulator.AirPlayDevice.make()
        const airplayDevice = new AirPlayDevice({
          name: device.name,
          ip: Brands.Ipv4.make("127.0.0.1"),
          port: device.port
        })

        yield* Session.rate(airplayDevice, 0)

        const info = yield* Session.playbackInfo(airplayDevice)
        assert.ok(Option.isSome(info))
        const value = Option.getOrThrow(info)
        assert.strictEqual(value.rate, 0)
      }).pipe(Effect.provide(TestLayer), Effect.scoped))
  })
})
