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

        const idOf = (request: Option.Option<State.SeekRequest>) =>
          Option.getOrElse(Option.map(request, (value) => value.id), () => 0)

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
})
