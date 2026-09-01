// The remembered state.
//
// The interesting requirement is not that it stores things — it is that it
// never gets in the way. A missing file, an unwritable directory or JSON left
// behind by an older schema all have to mean "nothing remembered", because none
// of them is a reason to refuse to play a film.

import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { FileSystem } from "effect/FileSystem"
import { NodeServices } from "@effect/platform-node"
import { Brands, FilePath } from "@castcli/domain"
import * as State from "../src/State.ts"

const FILM = FilePath.make("/movies/disclosure-day.mkv")
const OTHER = FilePath.make("/movies/something-else.mkv")
const TV = Brands.Ipv4.make("192.168.1.24")

/**
 * Run against a store rooted in a scratch directory, which is removed with the
 * scope. `XDG_STATE_HOME` is how the module decides where to write, so pointing
 * it at a temporary directory also checks that it is honoured at all.
 */
const withStore = <A, E>(use: (directory: string) => Effect.Effect<A, E, State.Store>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()

    return yield* use(directory).pipe(
      Effect.provide(
        State.Store.layer.pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_STATE_HOME: directory }))
          )
        )
      )
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const idOf = (request: Option.Option<State.SeekRequest>) =>
  Option.getOrElse(Option.map(request, (value) => value.id), () => 0)

describe("State", () => {
  it.effect("remembers nothing before anything has been written", () =>
    withStore(() =>
      Effect.gen(function*() {
        assert.isTrue(Option.isNone(yield* State.positionOf(FILM)))
        assert.isTrue(Option.isNone(yield* State.rememberedDevice))
      })
    ))

  it.effect("round-trips a position and a device", () =>
    withStore(() =>
      Effect.gen(function*() {
        yield* State.rememberPosition(FILM, Brands.Seconds.make(396.09))
        yield* State.rememberDevice(TV)

        assert.deepStrictEqual(
          yield* State.positionOf(FILM),
          Option.some(Brands.Seconds.make(396.09))
        )
        assert.deepStrictEqual(yield* State.rememberedDevice, Option.some(TV))
      })
    ))

  it.effect("keeps a position per file rather than one for everything", () =>
    withStore(() =>
      Effect.gen(function*() {
        yield* State.rememberPosition(FILM, Brands.Seconds.make(100))
        yield* State.rememberPosition(OTHER, Brands.Seconds.make(200))

        assert.deepStrictEqual(
          yield* State.positionOf(FILM),
          Option.some(Brands.Seconds.make(100))
        )
        assert.deepStrictEqual(
          yield* State.positionOf(OTHER),
          Option.some(Brands.Seconds.make(200))
        )
      })
    ))

  it.effect("does not lose one field when another is written", () =>
    withStore(() =>
      Effect.gen(function*() {
        yield* State.rememberDevice(TV)
        yield* State.rememberPosition(FILM, Brands.Seconds.make(42))

        // Each writer reads first and writes the whole document, so a careless
        // change here would silently drop whatever it did not know about.
        assert.deepStrictEqual(yield* State.rememberedDevice, Option.some(TV))
        assert.deepStrictEqual(yield* State.positionOf(FILM), Option.some(Brands.Seconds.make(42)))
      })
    ))

  it.effect("gives each seek request a higher id, so a repeat is still noticed", () =>
    withStore(() =>
      Effect.gen(function*() {
        // Seeking twice to the same position is a legitimate thing to do, and
        // comparing positions alone would swallow the second request.
        yield* State.requestSeek(Brands.Seconds.make(60))
        const first = yield* State.pendingSeek
        yield* State.requestSeek(Brands.Seconds.make(60))
        const second = yield* State.pendingSeek

        assert.isTrue(idOf(second) > idOf(first))
      })
    ))

  it.effect("treats an unreadable state file as nothing remembered", () =>
    withStore((directory) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem
        yield* fs.makeDirectory(`${directory}/castcli`, { recursive: true })
        yield* fs.writeFileString(`${directory}/castcli/state.json`, "this is not json")

        // Not a failure: a corrupt bookmark is a reason to forget it, not a
        // reason to stop.
        assert.isTrue(Option.isNone(yield* State.positionOf(FILM)))
        assert.isTrue(Option.isNone(yield* State.rememberedDevice))
      }).pipe(Effect.provide(NodeServices.layer))
    ))

  it.effect("does not overwrite garbage JSON with empty pairings", () =>
    withStore((directory) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem
        const file = `${directory}/castcli/state.json`
        yield* fs.makeDirectory(`${directory}/castcli`, { recursive: true })
        yield* fs.writeFileString(file, "this is not json")

        yield* State.rememberPosition(FILM, Brands.Seconds.make(12))

        const raw = yield* fs.readFileString(file)
        assert.strictEqual(raw, "this is not json")
        assert.isTrue(Option.isNone(yield* State.positionOf(FILM)))
      }).pipe(Effect.provide(NodeServices.layer))
    ))

  const samplePairing = () =>
    new State.AirPlayPairing({
      deviceIp: TV,
      deviceId: "62:8A:09:C1:74:B7",
      controllerIdentifier: "test-controller",
      controllerPublicKey: new Uint8Array(32).fill(1),
      controllerPrivateKey: new Uint8Array(32).fill(2),
      accessoryIdentifier: new TextEncoder().encode("62:8A:09:C1:74:B7"),
      accessoryPublicKey: new Uint8Array(32).fill(3)
    })

  it.effect("keeps pairings when a sibling field is invalid", () =>
    withStore((directory) =>
      Effect.gen(function*() {
        const pairing = samplePairing()
        yield* State.storeAirPlayPairing(pairing)

        const fs = yield* FileSystem
        const file = `${directory}/castcli/state.json`
        const raw = yield* fs.readFileString(file)
        yield* fs.writeFileString(
          file,
          raw.replace('"positions":{}', '"positions":"not-a-record","unexpected":{"broken":true}')
        )

        yield* State.rememberPosition(FILM, Brands.Seconds.make(77))

        const loaded = yield* State.getAirPlayPairing(TV, Option.some("62:8A:09:C1:74:B7"))
        assert.isTrue(Option.isSome(loaded))
        const value = Option.getOrThrow(loaded)
        assert.strictEqual(value.controllerIdentifier, "test-controller")
        assert.deepStrictEqual(
          yield* State.positionOf(FILM),
          Option.some(Brands.Seconds.make(77))
        )
        const after = yield* fs.readFileString(file)
        assert.isTrue(after.includes("controllerPublicKey"))
        assert.isFalse(after.includes('"airplayPairings":{}'))
      }).pipe(Effect.provide(NodeServices.layer))
    ))

  it.effect("keeps good pairings when one pairing record is corrupt", () =>
    withStore((directory) =>
      Effect.gen(function*() {
        const pairing = samplePairing()
        yield* State.storeAirPlayPairing(pairing)

        const fs = yield* FileSystem
        const file = `${directory}/castcli/state.json`
        const raw = yield* fs.readFileString(file)
        const withBad = raw.replace(
          '"airplayPairings":{',
          '"airplayPairings":{"bad-device":{"deviceIp":"not-an-ip"},'
        )
        yield* fs.writeFileString(file, withBad)

        yield* State.rememberPosition(FILM, Brands.Seconds.make(5))

        const loaded = yield* State.getAirPlayPairing(TV, Option.some("62:8A:09:C1:74:B7"))
        assert.isTrue(Option.isSome(loaded))
        const after = yield* fs.readFileString(file)
        assert.isFalse(after.includes("bad-device"))
      }).pipe(Effect.provide(NodeServices.layer))
    ))

  it.effect("reuses cue counts only while the file is unchanged", () =>
    withStore(() =>
      Effect.gen(function*() {
        yield* State.rememberCueCounts(FILM, "1234:5678", { "4": 24, "5": 1670 })

        // The same file: the counts are worth seconds each, so reuse them.
        const same = yield* State.cachedCueCounts(FILM, "1234:5678")
        assert.deepStrictEqual(
          Option.map(same, (cached) => cached.counts["5"]),
          Option.some(1670)
        )

        // A different file behind the same name — a re-encode, say. A stale
        // count would be worse than a slow one, so it is not offered.
        assert.isTrue(Option.isNone(yield* State.cachedCueCounts(FILM, "9999:5678")))
        assert.isTrue(Option.isNone(yield* State.cachedCueCounts(OTHER, "1234:5678")))
      })
    ))

  it.effect("round-trips an AirPlay pairing as base64, not index objects", () =>
    withStore((directory) =>
      Effect.gen(function*() {
        const pairing = new State.AirPlayPairing({
          deviceIp: TV,
          deviceId: "62:8A:09:C1:74:B7",
          controllerIdentifier: "test-controller",
          controllerPublicKey: new Uint8Array(32).fill(1),
          controllerPrivateKey: new Uint8Array(32).fill(2),
          accessoryIdentifier: new TextEncoder().encode("62:8A:09:C1:74:B7"),
          accessoryPublicKey: new Uint8Array(32).fill(3)
        })
        yield* State.storeAirPlayPairing(pairing)
        const loaded = yield* State.getAirPlayPairing(TV, Option.some("62:8A:09:C1:74:B7"))
        assert.isTrue(Option.isSome(loaded))
        const value = Option.getOrThrow(loaded)
        assert.deepStrictEqual(Array.from(value.controllerPublicKey), Array.from(pairing.controllerPublicKey))
        assert.deepStrictEqual(Array.from(value.controllerPrivateKey), Array.from(pairing.controllerPrivateKey))
        const fs = yield* FileSystem
        const raw = yield* fs.readFileString(`${directory}/castcli/state.json`)
        assert.isFalse(raw.includes('"0":'))
        assert.isTrue(raw.includes("controllerPublicKey"))
      }).pipe(Effect.provide(NodeServices.layer))
    ))

  it.effect("rejects IP fallback when deviceId does not match", () =>
    withStore(() =>
      Effect.gen(function*() {
        const deviceA = new State.AirPlayPairing({
          deviceIp: TV,
          deviceId: "62:8A:09:C1:74:B7",
          controllerIdentifier: "test-controller-a",
          controllerPublicKey: new Uint8Array(32).fill(1),
          controllerPrivateKey: new Uint8Array(32).fill(2),
          accessoryIdentifier: new TextEncoder().encode("62:8A:09:C1:74:B7"),
          accessoryPublicKey: new Uint8Array(32).fill(3)
        })
        yield* State.storeAirPlayPairing(deviceA)
        const loaded = yield* State.getAirPlayPairing(TV, Option.some("62:AB:10:55:D7:24"))
        assert.isTrue(Option.isNone(loaded))
      })
    ))

  it.effect("allows IP fallback when IP record has no deviceId", () =>
    withStore(() =>
      Effect.gen(function*() {
        const deviceNoId = new State.AirPlayPairing({
          deviceIp: TV,
          controllerIdentifier: "test-controller-legacy",
          controllerPublicKey: new Uint8Array(32).fill(1),
          controllerPrivateKey: new Uint8Array(32).fill(2),
          accessoryIdentifier: new TextEncoder().encode("legacy-device"),
          accessoryPublicKey: new Uint8Array(32).fill(3)
        })
        yield* State.storeAirPlayPairing(deviceNoId)
        const loaded = yield* State.getAirPlayPairing(TV, Option.some("62:AB:10:55:D7:24"))
        assert.isTrue(Option.isSome(loaded))
        const value = Option.getOrThrow(loaded)
        assert.strictEqual(value.controllerIdentifier, "test-controller-legacy")
      })
    ))

  it.effect("allows IP fallback when deviceId matches", () =>
    withStore(() =>
      Effect.gen(function*() {
        const device = new State.AirPlayPairing({
          deviceIp: TV,
          deviceId: "62:AB:10:55:D7:24",
          controllerIdentifier: "test-controller-match",
          controllerPublicKey: new Uint8Array(32).fill(1),
          controllerPrivateKey: new Uint8Array(32).fill(2),
          accessoryIdentifier: new TextEncoder().encode("62:AB:10:55:D7:24"),
          accessoryPublicKey: new Uint8Array(32).fill(3)
        })
        yield* State.storeAirPlayPairing(device)
        const loaded = yield* State.getAirPlayPairing(TV, Option.some("62:AB:10:55:D7:24"))
        assert.isTrue(Option.isSome(loaded))
        const value = Option.getOrThrow(loaded)
        assert.strictEqual(value.controllerIdentifier, "test-controller-match")
      })
    ))
})
