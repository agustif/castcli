import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeServices } from "@effect/platform-node"
import { NodeCrypto } from "@effect/platform-node"
import { AirPlayDevice, Brands } from "@castcli/domain"
import * as Emulator from "@castcli/emulator"
import * as Session from "../src/Session.ts"
import { NodeSuite } from "../src/index.ts"

const TestLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  NodeServices.layer,
  Layer.provide(NodeSuite, NodeCrypto.layer)
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

  describe("auth-setup", () => {
    it.effect("device with requireAuthSetup rejects /command when auth-setup not posted", () =>
      Effect.gen(function*() {
        const device = yield* Emulator.AirPlayDevice.make({
          requireAuthSetup: true,
          requirePairing: false
        })

        const { HttpClientRequest, HttpBody, HttpClient } = yield* Effect.promise(() => import("effect/unstable/http"))
        const client = yield* HttpClient.HttpClient

        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>type</key><string>insertPlayQueueItem</string>
  <key>Content-Location</key><string>http://example.com/test.mp4</string>
  <key>Start-Position</key><real>0</real>
</dict>
</plist>`

        const commandUrl = `http://127.0.0.1:${device.port}/command`

        const commandResponse = yield* client.execute(
          HttpClientRequest.post(commandUrl, {
            body: HttpBody.text(plist, "application/x-apple-plist")
          })
        )

        assert.strictEqual(commandResponse.status, 403)
      }).pipe(Effect.provide(TestLayer), Effect.scoped))

    it.effect("requiresMFiAuth does not detect bit 26 (HasUnifiedAdvertiserInfo)", () =>
      Effect.succeed(undefined).pipe(
        Effect.map(() => {
          const airplayDevice = new AirPlayDevice({
            name: "test",
            ip: Brands.Ipv4.make("127.0.0.1"),
            port: Brands.Port.make(7000),
            features: (1n << 26n)
          })

          assert.strictEqual(airplayDevice.requiresMFiAuth, false)
        }),
        Effect.provide(TestLayer)
      ))

    it.effect("requiresMFiAuth detects bit 51", () =>
      Effect.succeed(undefined).pipe(
        Effect.map(() => {
          const airplayDevice = new AirPlayDevice({
            name: "test",
            ip: Brands.Ipv4.make("127.0.0.1"),
            port: Brands.Port.make(7000),
            features: (1n << 51n)
          })

          assert.strictEqual(airplayDevice.requiresMFiAuth, true)
        }),
        Effect.provide(TestLayer)
      ))

    it.effect("requiresMFiAuth is false when bits not set", () =>
      Effect.succeed(undefined).pipe(
        Effect.map(() => {
          const airplayDevice = new AirPlayDevice({
            name: "test",
            ip: Brands.Ipv4.make("127.0.0.1"),
            port: Brands.Port.make(7000),
            features: 0n
          })

          assert.strictEqual(airplayDevice.requiresMFiAuth, false)
        }),
        Effect.provide(TestLayer)
      ))
  })
})
