// Generates the Cast wire descriptors from the vendored `cast_channel.proto`.
//
// The previous hand-written encoder embedded literal wire keys (`0x12`, `0x1a`,
// …). Those were correct — verified field by field against this same file — but
// correct *by transcription*, which is a property that decays. Deriving them
// makes the protobuf definition the single source of truth, so a change
// upstream shows up as a diff in the generated file rather than as a device
// that silently ignores our messages.
//
//   npm run codegen        regenerate
//   npm run codegen:check  fail if the checked-in output is stale
//
// A build script may touch the filesystem directly; the runtime code may not.

import { Effect, Option } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as process from "node:process"

const ROOT = path.resolve(import.meta.dirname, "..")
const PROTO = path.join(ROOT, "docs/reference/cast_channel.proto")
const OUTPUT = path.join(ROOT, "src/Cast/Protocol/Generated.ts")

/** proto2 scalar types, mapped to protobuf wire types. Enums are varints. */
const WIRE_TYPES: Record<string, "varint" | "length"> = {
  string: "length",
  bytes: "length",
  bool: "varint",
  int32: "varint",
  int64: "varint",
  uint32: "varint",
  uint64: "varint",
  fixed32: "fixed32",
  fixed64: "fixed64"
} as Record<string, "varint" | "length">

interface Field {
  readonly name: string
  readonly number: number
  readonly rule: string
  readonly type: string
  readonly wire: "varint" | "length"
}

const MESSAGE_RE = /^\s*message\s+([A-Za-z0-9_]+)\s*\{/
const ENUM_RE = /^\s*enum\s+([A-Za-z0-9_]+)\s*\{/
const FIELD_RE = /^\s*(required|optional|repeated)\s+([A-Za-z0-9_.]+)\s+([a-z0-9_]+)\s*=\s*(\d+)/
const ENUM_VALUE_RE = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(\d+)/
const CLOSE_RE = /^\s*\}/

interface ParseState {
  readonly stack: ReadonlyArray<string>
  readonly messages: ReadonlyMap<string, ReadonlyArray<Field>>
  readonly enums: ReadonlyMap<string, ReadonlyArray<readonly [string, number]>>
}

const append = <K, V>(
  map: ReadonlyMap<K, ReadonlyArray<V>>,
  key: K,
  value: V
): ReadonlyMap<K, ReadonlyArray<V>> => new Map(map).set(key, [...(map.get(key) ?? []), value])

/**
 * A deliberately small proto2 reader: enough for this one file. Anything it
 * cannot classify is skipped rather than guessed at, and the conformance test
 * catches the resulting gap.
 */
const step = (state: ParseState, line: string): ParseState => {
  const enclosingMessage = state.stack.findLast((entry) => !entry.startsWith("enum:"))
  const currentEnum = state.stack.at(-1)?.startsWith("enum:") === true
    ? state.stack.at(-1)!.slice("enum:".length)
    : undefined

  return Option.match(Option.fromNullishOr(MESSAGE_RE.exec(line)), {
    onSome: (match) => ({
      ...state,
      stack: [...state.stack, match[1]!],
      messages: new Map(state.messages).set(match[1]!, [])
    }),
    onNone: () =>
      Option.match(Option.fromNullishOr(ENUM_RE.exec(line)), {
        onSome: (match) => {
          // Nested enums are qualified by their enclosing message, matching how
          // field declarations refer to them.
          const name = enclosingMessage === undefined
            ? match[1]!
            : `${enclosingMessage}.${match[1]}`
          return {
            ...state,
            stack: [...state.stack, `enum:${name}`],
            enums: new Map(state.enums).set(name, [])
          }
        },
        onNone: () =>
          currentEnum !== undefined
            ? Option.match(Option.fromNullishOr(ENUM_VALUE_RE.exec(line)), {
              onSome: (match) => ({
                ...state,
                enums: append(state.enums, currentEnum, [match[1]!, Number(match[2])] as const)
              }),
              onNone: () => (CLOSE_RE.test(line) ? { ...state, stack: state.stack.slice(0, -1) } : state)
            })
            : Option.match(Option.fromNullishOr(FIELD_RE.exec(line)), {
              onSome: (match) =>
                enclosingMessage === undefined ? state : {
                  ...state,
                  messages: append(state.messages, enclosingMessage, {
                    name: match[3]!,
                    number: Number(match[4]),
                    rule: match[1]!,
                    type: match[2]!,
                    wire: WIRE_TYPES[match[2]!] ?? "varint"
                  })
                },
              onNone: () => (CLOSE_RE.test(line) ? { ...state, stack: state.stack.slice(0, -1) } : state)
            })
      })
  })
}

/**
 * Put every brace and statement on its own line first. `cast_channel.proto`
 * declares `enum ProtocolVersion { CASTV2_1_0 = 0; }` entirely inline, which a
 * line-oriented reader would otherwise open without ever closing — corrupting
 * the scope stack for everything after it.
 */
const normalise = (source: string): ReadonlyArray<string> =>
  source
    .replace(/\{/g, "{\n")
    .replace(/\}/g, "\n}\n")
    .replace(/;/g, ";\n")
    .split("\n")

const parse = (source: string): ParseState =>
  normalise(source).reduce(step, {
    stack: [],
    messages: new Map(),
    enums: new Map()
  })

const wireNumber = (wire: Field["wire"]): number => (wire === "length" ? 2 : 0)

const emit = (parsed: ParseState): string => {
  const fields = (parsed.messages.get("CastMessage") ?? [])
    .map((field) =>
      `  ${field.name}: {\n` +
      `    number: ${field.number},\n` +
      `    wire: "${field.wire}",\n` +
      `    rule: "${field.rule}",\n` +
      `    type: "${field.type}",\n` +
      `    /** (${field.number} << 3) | ${wireNumber(field.wire)} */\n` +
      `    key: 0x${((field.number << 3) | wireNumber(field.wire)).toString(16)}\n` +
      `  }`
    )
    .join(",\n")

  const enumBlock = (name: string, key: string) =>
    `export const ${name} = {\n` +
    (parsed.enums.get(key) ?? [])
      .map(([label, value]) => `  ${label}: ${value}`)
      .join(",\n") +
    "\n} as const\n"

  return `// GENERATED — do not edit.
//
// Source: docs/reference/cast_channel.proto (Chromium, BSD-licensed).
// Regenerate with \`npm run codegen\`; \`npm run codegen:check\` fails if stale.
//
// Wire keys are derived, not transcribed: key = (fieldNumber << 3) | wireType,
// where wireType is 0 for varints and 2 for length-delimited values.

export interface FieldDescriptor {
  readonly number: number
  readonly wire: "varint" | "length"
  readonly rule: string
  readonly type: string
  readonly key: number
}

export const CastMessageFields = {
${fields}
} as const satisfies Record<string, FieldDescriptor>

export type CastMessageField = keyof typeof CastMessageFields

/** Reverse lookup: field number to field name, for the decoder. */
export const byNumber: ReadonlyMap<number, CastMessageField> = new Map(
  Object.entries(CastMessageFields).map(([name, d]) => [d.number, name as CastMessageField])
)

${enumBlock("ProtocolVersion", "CastMessage.ProtocolVersion")}
${enumBlock("PayloadType", "CastMessage.PayloadType")}`
}

const program = Effect.gen(function*() {
  const source = yield* Effect.try({
    try: () => readFileSync(PROTO, "utf8"),
    catch: (cause) => new Error(`cannot read ${PROTO}: ${String(cause)}`)
  })
  const parsed = parse(source)
  const output = emit(parsed)
  const fieldCount = (parsed.messages.get("CastMessage") ?? []).length

  const existing = yield* Effect.try({
    try: () => readFileSync(OUTPUT, "utf8"),
    catch: () => new Error("missing")
  }).pipe(Effect.orElseSucceed(() => ""))

  return yield* process.argv.includes("--check")
    ? existing === output
      ? Effect.logInfo(`protocol descriptors are up to date (${fieldCount} fields)`)
      : Effect.fail(
        new Error(`${OUTPUT} is stale — run \`npm run codegen\` and commit the result`)
      )
    : Effect.sync(() => writeFileSync(OUTPUT, output)).pipe(
      Effect.andThen(
        Effect.logInfo(`wrote ${path.relative(ROOT, OUTPUT)} (${fieldCount} fields)`)
      )
    )
})

NodeRuntime.runMain(program)
