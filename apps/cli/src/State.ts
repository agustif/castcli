// What the CLI remembers between invocations.
//
// Three things, each removing a decision someone would otherwise have to make
// again: which device they last used, how far they got into each file, and
// where the currently-playing stream starts — which `cast seek` needs, because
// the receiver reports time within the current stream rather than within the
// film, and the process that knows the difference is a different process.
//
// A missing file is empty memory, which is a perfectly good state to start
// from. An *existing* file that will not decode is not: AirPlay pairings live
// here, and overwriting them with empty because a sibling field drifted would
// forget every television. Play still proceeds (reads look like empty); writes
// refuse to persist that empty over the file they failed to read.

import { Config, Context, Data, Effect, Layer, Match, Option, Schema } from "effect"
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
   * True under HLS, where every segment of the film is addressable. Progressive
   * `/stream` is a finished faststart MP4 with byte ranges, not a live pipe.
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
 * AirPlay pairing record for a specific device.
 * 
 * Stores the long-term keys established during pair-setup.
 * Keyed by device accessory ID (from TXT deviceid) first, with IP as fallback
 * for existing state compatibility.
 * 
 * Keys are encoded as base64 for JSON persistence.
 */
export class AirPlayPairing extends Schema.Class<AirPlayPairing>("AirPlayPairing")({
  /** Device IP address (deprecated key, kept for backward compatibility) */
  deviceIp: Ipv4,
  /** Device accessory ID from TXT deviceid (preferred key) */
  deviceId: Schema.optionalKey(Schema.String),
  /** Controller (sender) identity */
  controllerIdentifier: Schema.String,
  controllerPublicKey: Schema.Uint8ArrayFromBase64,
  controllerPrivateKey: Schema.Uint8ArrayFromBase64,
  /** Accessory (receiver) long-term Ed25519 public key and identifier */
  accessoryIdentifier: Schema.Uint8ArrayFromBase64,
  accessoryPublicKey: Schema.Uint8ArrayFromBase64,
  /** Whether this is a transient pairing (Mac receivers, no long-term storage) */
  transient: Schema.optionalKey(Schema.Boolean),
  /** SRP session key for transient pairing (base64) */
  srpSessionKey: Schema.optionalKey(Schema.Uint8ArrayFromBase64)
}) {}

/**
 * The device the last command acted on.
 *
 * Tagged, because the three protocols are not identified by the same thing and
 * the difference is not cosmetic: a control command has to know which network
 * to sweep before it can act, and devices in the same room will answer to
 * "the last device I used" regardless of protocol.
 *
 * The Cast and AirPlay arms keep an address, which is a DHCP lease rather than
 * an identity and so can go stale. That costs one failed connection and then
 * discovery runs anyway, which is why the shortcut can only ever save time.
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
  Dlna: { friendlyName: Schema.String },
  AirPlay: { ip: Ipv4 }
})

export type LastTarget = typeof LastTarget.Type

/**
 * Pairings that can be decoded. A single corrupt record must not fail the
 * document: that is how one bad device entry used to wipe every other pairing.
 * `catchDecoding` with `Option.none` drops the key rather than the map.
 */
const AirPlayPairings = Schema.Record(
  Schema.String,
  AirPlayPairing.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none())))
).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some({})))
)

const dropInvalid = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none())))

export class Remembered extends Schema.Class<Remembered>("Remembered")({
  lastTarget: Schema.optional(dropInvalid(LastTarget)),
  /** Absolute path to the position last reported for it. */
  positions: Schema.optionalKey(
    Schema.Record(Schema.String, Seconds).pipe(
      Schema.catchDecoding(() => Effect.succeed(Option.some({})))
    )
  ),
  active: Schema.optional(dropInvalid(ActiveStream)),
  seek: Schema.optional(dropInvalid(SeekRequest)),
  cues: Schema.optionalKey(
    Schema.Record(Schema.String, CueCounts).pipe(
      Schema.catchDecoding(() => Effect.succeed(Option.some({})))
    )
  ),
  /** AirPlay pairings by device ID (preferred) or IP (fallback) */
  airplayPairings: Schema.optionalKey(AirPlayPairings)
}) {}

const EMPTY = new Remembered({ positions: {}, airplayPairings: {} })

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

type Snapshot = Data.TaggedEnum<{
  readonly Missing: {}
  readonly Ready: { readonly state: Remembered }
  readonly Unreadable: {}
}>

const Snapshot = Data.taggedEnum<Snapshot>()

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

      const snapshot = fs.readFileString(file).pipe(
        Effect.flatMap((json) =>
          decode(json).pipe(
            Effect.map((state) => Snapshot.Ready({ state })),
            Effect.tapError((issue) =>
              Effect.logError(
                "state.json exists but could not be decoded; leaving the file untouched",
                issue
              )
            ),
            Effect.catch(() => Effect.succeed(Snapshot.Unreadable()))
          )
        ),
        Effect.catchTag("PlatformError", (error) =>
          Match.value(error.reason._tag).pipe(
            Match.when("NotFound", () => Effect.succeed(Snapshot.Missing())),
            Match.orElse(() =>
              Effect.logWarning("could not read the state file", error).pipe(
                Effect.as(Snapshot.Unreadable())
              )
            )
          )
        )
      )

      const view: (loaded: Snapshot) => Remembered = Match.type<Snapshot>().pipe(
        Match.tag("Missing", () => EMPTY),
        Match.tag("Ready", ({ state }) => state),
        Match.tag("Unreadable", () => EMPTY),
        Match.exhaustive
      )

      const read = Effect.map(snapshot, view)

      const write = (state: Remembered) =>
        Effect.gen(function*() {
          const directory = path.dirname(file)
          yield* fs.makeDirectory(directory, { recursive: true })
          const json = yield* encode(state)
          const temp = yield* fs.makeTempFile({ directory, prefix: "state.", suffix: ".tmp" })
          yield* fs.writeFileString(temp, json)
          yield* fs.rename(temp, file)
        }).pipe(
          // Best effort, and deliberately quiet at info level: someone watching
          // a film does not need to hear that a bookmark could not be saved.
          Effect.catchCause((cause) =>
            Effect.logDebug("could not write the state file", cause)
          )
        )

      const update = (change: (state: Remembered) => Remembered) =>
        Effect.flatMap(
          snapshot,
          Match.type<Snapshot>().pipe(
            Match.tag("Missing", () => write(change(EMPTY))),
            Match.tag("Ready", ({ state }) => write(change(state))),
            Match.tag("Unreadable", () =>
              Effect.logError(
                "not writing over an unreadable state.json (AirPlay pairings must not be wiped)"
              )
            ),
            Match.exhaustive
          )
        )

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
  Match.tag("AirPlay", ({ ip }) => Option.some(ip)),
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

export const rememberAirPlay = (ip: Ipv4) => rememberTarget({ _tag: "AirPlay", ip })

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

/** Get stored AirPlay pairing for a device, by deviceId (preferred) or IP (fallback) */
export const getAirPlayPairing = (deviceIp: Ipv4, deviceId: Option.Option<string>) =>
  Effect.flatMap(Store, (store) =>
    Effect.flatMap(store.read, (state) =>
      Effect.gen(function*() {
        const key = Option.getOrElse(deviceId, () => deviceIp)
        const pairing = yield* Option.match(deviceId, {
          onNone: () => Effect.succeed(Option.fromNullishOr(state.airplayPairings?.[deviceIp])),
          onSome: (id) => Effect.gen(function*() {
            const byId = Option.fromNullishOr(state.airplayPairings?.[id])
            return yield* Option.match(byId, {
              onSome: (found) => Effect.succeed(Option.some(found)),
              onNone: () => Effect.gen(function*() {
                const byIp = Option.fromNullishOr(state.airplayPairings?.[deviceIp])
                return yield* Option.match(byIp, {
                  onNone: () => Effect.succeed(Option.none()),
                  onSome: (ipPairing) => Effect.gen(function*() {
                    return yield* Match.value(ipPairing.deviceId).pipe(
                      Match.when(undefined, () => Effect.succeed(Option.some(ipPairing))),
                      Match.when(id, () => Effect.succeed(Option.some(ipPairing))),
                      Match.orElse(() => Effect.gen(function*() {
                        yield* Effect.logDebug(
                          `IP fallback rejected: ${deviceIp} has deviceId=${ipPairing.deviceId}, requested ${id}`
                        )
                        return Option.none()
                      }))
                    )
                  })
                })
              })
            })
          })
        })
        
        yield* Option.match(pairing, {
          onNone: () => Effect.logDebug(`AirPlay pairing not found for ${key}`),
          onSome: (p) =>
            Effect.logDebug(
              `AirPlay pairing loaded for ${key}: ` +
                `controller=${p.controllerPublicKey.length}B, ` +
                `accessory=${p.accessoryPublicKey.length}B`
            )
        })
        
        return pairing
      })))

/** Store AirPlay pairing for a device, keyed by deviceId if available, otherwise IP */
export const storeAirPlayPairing = (pairing: AirPlayPairing) =>
  Effect.flatMap(Store, (store) =>
    Effect.gen(function*() {
      const key = pairing.deviceId ?? pairing.deviceIp
      yield* Effect.logInfo(
        `Storing AirPlay pairing for ${key}: ` +
          `controller=${pairing.controllerPublicKey.length}B, ` +
          `accessory=${pairing.accessoryPublicKey.length}B`
      )
      
      yield* store.update((state) => {
        const existingPairings = state.airplayPairings ?? {}
        return new Remembered({
          ...state,
          airplayPairings: { ...existingPairings, [key]: pairing }
        })
      })
    }))
