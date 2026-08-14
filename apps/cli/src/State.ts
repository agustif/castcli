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

import { Config, Context, Effect, Layer, Match, Option, Schema } from "effect"
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

/**
 * The device the last command acted on.
 *
 * Tagged, because the two protocols are not identified by the same thing and
 * the difference is not cosmetic: a control command has to know which network
 * to sweep before it can act, and a television and a Chromecast in the same
 * room will both answer to "the last device I used".
 *
 * The Cast arm keeps an address, which is a DHCP lease rather than an identity
 * and so can go stale. That costs one failed connection and then discovery runs
 * anyway, which is why the shortcut can only ever save time.
 *
 * The DLNA arm deliberately keeps the renderer's **name** and not its
 * description URL, even though the URL is the thing `Renderer.connect` needs.
 * A description is served from an ephemeral port that the device is free to
 * change every time it reboots, and the URL carries no identity of its own — so
 * a remembered one points at nothing, or worse, at whatever else on that host
 * has since been given the port, and a `pause` would be posted at a stranger.
 * A name survives a reboot; turning it back into a URL costs one SSDP sweep,
 * which is what discovery would have cost anyway. A stale URL would be worse
 * than no memory at all, a stale name is merely no faster.
 */
export const LastTarget = Schema.TaggedUnion({
  Cast: { ip: Ipv4 },
  Dlna: { friendlyName: Schema.String }
})

export type LastTarget = typeof LastTarget.Type

export class Remembered extends Schema.Class<Remembered>("Remembered")({
  lastTarget: Schema.optional(LastTarget),
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

/** Whatever was last acted on, Cast or DLNA. */
export const rememberedTarget = Effect.flatMap(
  Store,
  (store) => Effect.map(store.read, (state) => Option.fromNullishOr(state.lastTarget))
)

const addressOf: (target: LastTarget) => Option.Option<Ipv4> = Match.type<LastTarget>().pipe(
  Match.tag("Cast", ({ ip }) => Option.some(ip)),
  // A renderer has no address worth handing to anything: it is reached through
  // the control URLs in its description, which are fetched afresh every time.
  Match.tag("Dlna", () => Option.none<Ipv4>()),
  Match.exhaustive
)

/**
 * The Cast address the last `play` used, if the last device was a Cast one.
 *
 * A narrower view of `rememberedTarget` for the callers that can only act on an
 * address at all. Absent when the last device was a renderer, which is the
 * point: answering with an address that belongs to some earlier session would
 * send a command to a device nobody has touched in days.
 */
export const rememberedDevice = Effect.map(
  rememberedTarget,
  (target) => Option.flatMap(target, addressOf)
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

const rememberTarget = (target: LastTarget) =>
  Effect.flatMap(Store, (store) =>
    store.update((state) => new Remembered({ ...state, lastTarget: target })))

export const rememberDevice = (ip: Ipv4) => rememberTarget({ _tag: "Cast", ip })

/**
 * A renderer is remembered by name. See `LastTarget` for why its description
 * URL, which is the thing actually needed to talk to it, is the one thing not
 * worth keeping.
 */
export const rememberRenderer = (friendlyName: string) =>
  rememberTarget({ _tag: "Dlna", friendlyName })

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
