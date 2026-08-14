// Extracts the Cast media vocabulary from the receiver framework Google ships.
//
// The literal sets in this protocol — player states, stream types, HLS segment
// formats, track kinds — were transcribed by hand from prose documentation.
// Transcription is correct at the moment it is done and decays afterwards, and
// the prose is wrong in at least two places: `HlsSegmentFormat` is written in
// caps there and lowercase on the wire, and the sender SDK documents a
// `StreamType` the receiver does not ship.
//
// So the shipped framework is the source of truth instead. It is minified, but
// its enums survive minification as object literals whose keys are the constant
// names, which makes them recoverable and — more usefully — *diffable*.
//
//   npm run vocabulary:sync    refetch from Google and update the snapshot
//   npm run codegen            regenerate the TypeScript from the snapshot
//   npm run codegen:check      fail if the checked-in output is stale
//
// The two steps are separate on purpose: `sync` needs the network and is a
// deliberate act, while `codegen` and its check must work offline, in CI, and
// produce the same bytes every time.

import { Effect, Schema } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as process from "node:process"

const ROOT = path.resolve(import.meta.dirname, "..")
const SNAPSHOT = path.join(ROOT, "packages/protocol/vendor/cast_receiver_vocabulary.json")

/** The framework a Cast device actually runs. */
const SOURCE_URL = "https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js"

/**
 * What to look for, and how to recognise it.
 *
 * Minification discards the names, so each table is identified by keys that
 * only it has. `requires` is deliberately narrow — a signature that also
 * matched a neighbouring table would silently bind the wrong values, so the
 * extractor fails on ambiguity rather than guessing.
 */
interface Wanted {
  readonly name: string
  readonly description: string
  readonly requires: ReadonlyArray<string>
  /**
   * Values that must match exactly, for tables that share a key set.
   *
   * The framework carries two tables keyed IDLE/PLAYING/PAUSED/BUFFERING: the
   * media player states, in caps, and the receiver *application* states, in
   * lowercase and including `launching` and `loading`. Only the casing tells
   * them apart, and binding the wrong one would be silent.
   */
  readonly exactly?: Record<string, string>
}

const WANTED: ReadonlyArray<Wanted> = [
  {
    name: "PlayerState",
    description: "Player states the receiver reports.",
    requires: ["IDLE", "PLAYING", "PAUSED", "BUFFERING"],
    exactly: { IDLE: "IDLE" }
  },
  {
    name: "ApplicationState",
    description: "What the receiver application itself is doing. Lowercase on the wire.",
    requires: ["LAUNCHING", "IDLE", "LOADING", "BUFFERING", "PAUSED", "PLAYING"],
    exactly: { IDLE: "idle" }
  },
  {
    name: "StreamType",
    description: "How the receiver should treat the stream's timeline.",
    requires: ["BUFFERED", "LIVE", "NONE"]
  },
  {
    name: "HlsSegmentFormat",
    description: "Audio encoding of an HLS segment. Lowercase on the wire.",
    requires: ["TS_AAC", "TS_HE_AAC", "E_AC3", "FMP4"]
  },
  {
    name: "HlsVideoSegmentFormat",
    description: "Container of an HLS video segment.",
    requires: ["MPEG2_TS", "FMP4"]
  },
  {
    name: "TrackType",
    description: "What kind of media a track carries.",
    requires: ["TEXT", "AUDIO", "VIDEO"]
  },
  {
    name: "TextTrackType",
    description: "What a text track is for. SUBTITLES needs a language.",
    requires: ["SUBTITLES", "CAPTIONS", "DESCRIPTIONS", "CHAPTERS", "METADATA"]
  },
  {
    name: "CaptionMimeType",
    description: "Content types the receiver accepts for a text track.",
    requires: ["CEA608", "TTML", "VTT", "TTML_MP4"]
  },
  {
    name: "IdleReason",
    description: "Why the receiver went idle — how a finished film is told from a failure.",
    requires: ["CANCELLED", "INTERRUPTED", "FINISHED", "ERROR"]
  },
  {
    name: "ErrorType",
    description: "How a rejected request is described.",
    requires: ["INVALID_PLAYER_STATE", "LOAD_FAILED", "LOAD_CANCELLED", "INVALID_REQUEST"]
  },
  {
    name: "RepeatMode",
    description: "Queue repeat behaviour.",
    requires: ["REPEAT_OFF", "REPEAT_ALL", "REPEAT_SINGLE"]
  },
  {
    name: "HdrType",
    description: "Dynamic range of the video a device reports being able to show.",
    requires: ["SDR", "HDR", "DV"]
  }
]

/**
 * Object literals whose keys are all SCREAMING_CASE and whose values are all
 * short strings. That is what a Closure-compiled enum looks like after
 * minification, and nothing else in this file has that shape.
 */
const ENUM_LITERAL = /\{([A-Z][A-Z0-9_]*:"[^"]{1,40}"(?:,[A-Z][A-Z0-9_]*:"[^"]{1,40}")+)\}/g

const parseTable = (body: string): Record<string, string> =>
  Object.fromEntries(
    body.split(",").map((entry) => {
      const separator = entry.indexOf(":")
      return [
        entry.slice(0, separator),
        entry.slice(separator + 2, -1)
      ] as const
    })
  )

const tablesIn = (source: string): ReadonlyArray<Record<string, string>> =>
  [...source.matchAll(ENUM_LITERAL)].map((match) => parseTable(match[1] ?? ""))

const findTable = (
  tables: ReadonlyArray<Record<string, string>>,
  wanted: Wanted
): Effect.Effect<Record<string, string>, Error> => {
  const matches = tables.filter((table) =>
    wanted.requires.every((key) => Object.hasOwn(table, key)) &&
    Object.entries(wanted.exactly ?? {}).every(([key, value]) => table[key] === value)
  )
  const distinct = new Map(matches.map((table) => [JSON.stringify(table), table]))

  return distinct.size === 1
    ? Effect.succeed([...distinct.values()][0] ?? {})
    : Effect.fail(
      new Error(
        distinct.size === 0
          ? `no table in the receiver framework has all of ${wanted.requires.join(", ")} ` +
            `— ${wanted.name} may have been renamed or removed upstream`
          : `${distinct.size} different tables match ${wanted.name}; its signature is ambiguous`
      )
    )
}

/**
 * Decoded rather than trusted, even though this script wrote it: the snapshot
 * is a file on disk that outlives any one version of this script, and a shape
 * that has drifted should say so here rather than produce a confusing
 * TypeScript file.
 */
const Snapshot = Schema.Struct({
  source: Schema.String,
  sha256: Schema.String,
  extractedFrom: Schema.String,
  vocabularies: Schema.Record(
    Schema.String,
    Schema.Struct({
      description: Schema.String,
      values: Schema.Array(Schema.String)
    })
  )
})
type Snapshot = typeof Snapshot.Type

const sync = Effect.gen(function*() {
  yield* Effect.logInfo(`fetching ${SOURCE_URL}`)
  const source = yield* Effect.tryPromise({
    try: () => globalThis.fetch(SOURCE_URL).then((response) => response.text()),
    catch: (cause) => new Error(`could not fetch the receiver framework: ${cause}`)
  })

  const tables = tablesIn(source)
  yield* Effect.logInfo(`found ${tables.length} enum tables`)

  const vocabularies: Record<string, { description: string; values: ReadonlyArray<string> }> = {}
  for (const wanted of WANTED) {
    const table = yield* findTable(tables, wanted)
    // Sorted, so an upstream reordering is not a diff. The values are what we
    // send and match on; the constant names are Google's business.
    vocabularies[wanted.name] = {
      description: wanted.description,
      values: Object.values(table).toSorted()
    }
  }

  const snapshot: Snapshot = {
    source: SOURCE_URL,
    sha256: createHash("sha256").update(source).digest("hex"),
    extractedFrom: "cast_receiver_framework.js, the framework a Cast device runs",
    vocabularies
  }

  writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`)
  yield* Effect.logInfo(
    `wrote ${Object.keys(vocabularies).length} vocabularies to ${path.relative(ROOT, SNAPSHOT)}`
  )
})

const OUTPUT = path.join(ROOT, "packages/protocol/src/GeneratedVocabulary.ts")

const readSnapshot = Effect.try({
  try: () => readFileSync(SNAPSHOT, "utf8"),
  catch: () =>
    new Error(
      `no vocabulary snapshot at ${path.relative(ROOT, SNAPSHOT)} — run \`npm run vocabulary:sync\``
    )
}).pipe(
  Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Snapshot))),
  Effect.mapError((cause) =>
    new Error(`${path.relative(ROOT, SNAPSHOT)} is not a vocabulary snapshot: ${cause}`)
  )
)

const asLiterals = (name: string, description: string, values: ReadonlyArray<string>) =>
  `/** ${description} */\nexport const ${name} = Schema.Literals([\n` +
  values.map((value) => `  ${JSON.stringify(value)}`).join(",\n") +
  `\n])\nexport type ${name} = typeof ${name}.Type\n`

const render = (snapshot: Snapshot): string =>
  [
    "// Generated from the Cast receiver framework. Do not edit.",
    "//",
    `// Source:  ${snapshot.source}`,
    `// sha256:  ${snapshot.sha256}`,
    "//",
    "// These are the values a Cast device itself ships, which is not always what",
    "// the prose documentation says: `HlsSegmentFormat` is written in caps there",
    "// and lowercase here, and the sender SDK documents a third `StreamType` the",
    "// receiver spells differently.",
    "//",
    "//   npm run vocabulary:sync   refetch from Google and update the snapshot",
    "//   npm run codegen           regenerate this file from the snapshot",
    "",
    'import { Schema } from "effect"',
    "",
    ...Object.entries(snapshot.vocabularies).map(([name, vocabulary]) =>
      asLiterals(name, vocabulary.description, vocabulary.values)
    )
  ].join("\n")

const generate = Effect.gen(function*() {
  const snapshot = yield* readSnapshot
  const rendered = render(snapshot)

  return yield* process.argv.includes("--check")
    ? Effect.gen(function*() {
      const existing = yield* Effect.try({
        try: () => readFileSync(OUTPUT, "utf8"),
        catch: () => new Error(`${path.relative(ROOT, OUTPUT)} is missing — run \`npm run codegen\``)
      })
      return yield* existing === rendered
        ? Effect.logInfo(
          `receiver vocabulary is up to date ` +
            `(${Object.keys(snapshot.vocabularies).length} sets)`
        )
        : Effect.fail(
          new Error(
            `${path.relative(ROOT, OUTPUT)} is stale — run \`npm run codegen\``
          )
        )
    })
    : Effect.gen(function*() {
      writeFileSync(OUTPUT, rendered)
      yield* Effect.logInfo(
        `wrote ${Object.keys(snapshot.vocabularies).length} vocabularies to ` +
          path.relative(ROOT, OUTPUT)
      )
    })
})

const main = process.argv.includes("--sync") ? sync : generate

NodeRuntime.runMain(main)
