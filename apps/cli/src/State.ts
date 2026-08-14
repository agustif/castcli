// What the CLI remembers between invocations.
//
// Three things, each removing a decision someone would otherwise have to make
// again: which device they last used, how far they got into each file, and
// where the currently-playing stream starts — which `cast seek` needs, because
// the receiver reports time within the current stream rather than within the
// film, and the process that knows the difference is a different process.
//
// Nothing here is load bearing. A missing, unreadable or malformed state file
// must never stop a film from playing, so every read falls back to empty and
// every write is best effort. That policy is the reason this module exists
// rather than the calls being inlined: it has to be applied consistently.

import { Config, Context, Effect, Layer, Option, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { FilePath, Ipv4, Seconds } from "@castcli/domain"
import * as os from "node:os"

/** The stream currently being served, as `cast seek` needs to see it. */
export class ActiveStream extends Schema.Class<ActiveStream>("ActiveStream")({
  file: FilePath,
  /** Where the running stream begins; the receiver's clock is relative to it. */
  offsetSeconds: Seconds,
  /**
   * Whether the receiver can seek by itself.
   *
   * True under HLS, where every segment of the film is addressable. False for
   * the progressive stream, which is a live pipe with no byte ranges — there
   * the player has to restart ffmpeg at the new offset instead.
   */
  seekable: Schema.optionalKey(Schema.Boolean)
}) {}

/**
 * A seek asked for by another process. Carries an id because the same position
 * can legitimately be requested twice, and the player has to notice the second
 * one — comparing positions alone would swallow it.
 */
export class SeekRequest extends Schema.Class<SeekRequest>("SeekRequest")({
  id: Schema.Number,
  toSeconds: Seconds
}) {}

/**
 * Cue counts already paid for.
 *
 * Counting cues means extracting the track, which is seconds of work per
 * subtitle stream — the reason `cast streams` was slow enough to be annoying.
 * The count cannot change unless the file does, so it is keyed by size and
 * modification time as well as path: a re-encode under the same name is a
 * different file and gets counted again.
 */
export class CueCounts extends Schema.Class<CueCounts>("CueCounts")({
  fingerprint: Schema.String,
  counts: Schema.Record(Schema.String, Schema.Number)
}) {}

export class Remembered extends Schema.Class<Remembered>("Remembered")({
  lastDevice: Schema.optional(Ipv4),
  /** Absolute path to the position last reported for it. */
  positions: Schema.optionalKey(Schema.Record(Schema.String, Seconds)),
  active: Schema.optional(ActiveStream),
  seek: Schema.optional(SeekRequest),
  cues: Schema.optionalKey(Schema.Record(Schema.String, CueCounts))
}) {}

const EMPTY = new Remembered({ positions: {} })

const decode = Schema.decodeEffect(Schema.fromJsonString(Remembered))
const encode = Schema.encodeEffect(Schema.fromJsonString(Remembered))

/**
 * `XDG_STATE_HOME` when set, and its documented default otherwise. State rather
 * than cache or config: it is regenerable, but losing it is mildly annoying
 * rather than free.
 */
const stateFile = Effect.gen(function*() {
  const path = yield* Path
  const xdg = yield* Config.string("XDG_STATE_HOME").pipe(Config.option)
  const base = Option.getOrElse(xdg, () => path.join(os.homedir(), ".local", "state"))
  return path.join(base, "castcli", "state.json")
})

export class Store extends Context.Service<Store, {
  readonly read: Effect.Effect<Remembered>
  readonly update: (change: (state: Remembered) => Remembered) => Effect.Effect<void>
  readonly positionOf: (file: FilePath) => Effect.Effect<Option.Option<Seconds>>
}>()("@castcli/cli/Store") {
  static readonly layer = Layer.effect(
    Store,
    Effect.gen(function*() {
      const fs = yield* FileSystem
      const path = yield* Path
      const file = yield* stateFile

      // Every failure lands here: absent file, unreadable directory, JSON that
      // does not decode because the schema moved. All of them mean "nothing
      // remembered", which is a perfectly good state to start from.
      const read = fs.readFileString(file).pipe(
        Effect.flatMap(decode),
        Effect.orElseSucceed(() => EMPTY)
      )

      const write = (state: Remembered) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true })
          yield* fs.writeFileString(file, yield* encode(state))
        }).pipe(
          // Best effort, and deliberately quiet at info level: someone watching
          // a film does not need to hear that a bookmark could not be saved.
          Effect.catchCause((cause) =>
            Effect.logDebug("could not write the state file", cause)
          )
        )

      const update = (change: (state: Remembered) => Remembered) =>
        Effect.flatMap(read, (state) => write(change(state)))

      const positionOf = (target: FilePath) =>
        Effect.map(read, (state) => Option.fromNullishOr(state.positions?.[target]))

      return { read, update, positionOf } as const
    })
  )
}

/**
 * Ask the running player to seek somewhere it cannot reach by itself.
 *
 * The receiver can only seek within the stream it was given, which begins at
 * the offset of the last LOAD — so rewinding past that needs a fresh LOAD, and
 * only the process serving the file can issue one.
 */
export const requestSeek = (to: Seconds) =>
  Effect.flatMap(Store, (store) =>
    store.update((state) =>
      new Remembered({
        ...state,
        seek: new SeekRequest({ id: (state.seek?.id ?? 0) + 1, toSeconds: to })
      })))

export const pendingSeek = Effect.flatMap(
  Store,
  (store) => Effect.map(store.read, (state) => Option.fromNullishOr(state.seek))
)

/**
 * What is already known about this file's subtitle tracks.
 *
 * Absent when the file has changed since, which is the whole point of the
 * fingerprint: a stale count would be worse than a slow one.
 */
export const cachedCueCounts = (file: FilePath, fingerprint: string) =>
  Effect.flatMap(Store, (store) =>
    Effect.map(store.read, (state) =>
      Option.filter(
        Option.fromNullishOr(state.cues?.[file]),
        (cached) => cached.fingerprint === fingerprint
      )))

export const rememberCueCounts = (
  file: FilePath,
  fingerprint: string,
  counts: Record<string, number>
) =>
  Effect.flatMap(Store, (store) =>
    store.update((state) =>
      new Remembered({
        ...state,
        cues: { ...state.cues, [file]: new CueCounts({ fingerprint, counts }) }
      })))

/** The device the last `play` used. */
export const rememberedDevice = Effect.flatMap(
  Store,
  (store) => Effect.map(store.read, (state) => Option.fromNullishOr(state.lastDevice))
)

/** Where the running stream starts, if `play` published one. */
export const activeStream = Effect.flatMap(
  Store,
  (store) => Effect.map(store.read, (state) => Option.fromNullishOr(state.active))
)

/** How far into this file the viewer previously got. */
export const positionOf = (file: FilePath) =>
  Effect.flatMap(Store, (store) => store.positionOf(file))

/** Record how far into a file the viewer got. */
export const rememberPosition = (file: FilePath, at: Seconds) =>
  Effect.flatMap(Store, (store) =>
    store.update((state) =>
      new Remembered({
        ...state,
        positions: { ...state.positions, [file]: at }
      })))

export const rememberDevice = (ip: Ipv4) =>
  Effect.flatMap(Store, (store) =>
    store.update((state) => new Remembered({ ...state, lastDevice: ip })))

/** Publish where the running stream starts, so another process can seek in it. */
export const setActive = (active: Option.Option<ActiveStream>) =>
  Effect.flatMap(Store, (store) =>
    store.update((state) =>
      new Remembered({
        ...state,
        ...Option.match(active, {
          onNone: () => ({ active: undefined }),
          onSome: (value) => ({ active: value })
        })
      })))
