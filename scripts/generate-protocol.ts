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
const PROTO = path.join(ROOT, "packages/protocol/proto/cast_channel.proto")
const OUTPUT = path.join(ROOT, "packages/protocol/src/Generated.ts")

/** proto2 scalar types, mapped to protobuf wire types. Enums are varints. */
const WIRE_TYPES: Record<string, "varint" | "length"> = {
  string: "length",
  bytes: "length",
  bool: "varint",
  int32: "varint",
  int64: "varint",
  uint32: "varint",
  uint64: "varint"
  // Fixed-width types do not appear in cast_channel.proto; the conformance
  // test fails loudly if that ever changes.
}

interface Field {
  readonly name: string
  readonly number: number
  readonly rule: string
  readonly type: string
  readonly wire: "varint" | "length"
}

/** One capture group as an Option; `null` match and absent group are the same. */
const group = (match: RegExpExecArray | null, index: number): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(match), (m) => Option.fromNullishOr(m[index]))

/** Two groups at once; absent if either is missing. Tuple-typed, so
 * destructuring yields strings rather than string | undefined. */
const group2 = (match: RegExpExecArray | null, a: number, b: number) =>
  Option.all([group(match, a), group(match, b)] as const)

/** Four groups at once, for a field declaration. */
const group4 = (match: RegExpExecArray | null, a: number, b: number, c: number, d: number) =>
  Option.all([group(match, a), group(match, b), group(match, c), group(match, d)] as const)

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
  // A regex match guarantees its groups at runtime but not in the type; read
  // them as Options so the compiler agrees with the pattern rather than being
  // told to trust it.
  const top = state.stack.at(-1)
  const currentEnum = top?.startsWith("enum:") === true
    ? top.slice("enum:".length)
    : undefined

  return Option.match(group(MESSAGE_RE.exec(line), 1), {
    onSome: (name) => ({
      ...state,
      stack: [...state.stack, name],
      messages: new Map(state.messages).set(name, [])
    }),
    onNone: () =>
      Option.match(group(ENUM_RE.exec(line), 1), {
        onSome: (declared) => {
          // Nested enums are qualified by their enclosing message, matching how
          // field declarations refer to them.
          const name = enclosingMessage === undefined
            ? declared
            : `${enclosingMessage}.${declared}`
          return {
            ...state,
            stack: [...state.stack, `enum:${name}`],
            enums: new Map(state.enums).set(name, [])
          }
        },
        onNone: () =>
          currentEnum !== undefined
            ? Option.match(group2(ENUM_VALUE_RE.exec(line), 1, 2), {
              onSome: ([label, value]) => ({
                ...state,
                enums: append(state.enums, currentEnum, [label, Number(value)] as const)
              }),
              onNone: () => (CLOSE_RE.test(line) ? { ...state, stack: state.stack.slice(0, -1) } : state)
            })
            : Option.match(group4(FIELD_RE.exec(line), 1, 2, 3, 4), {
              onSome: ([rule, type, name, number]) =>
                enclosingMessage === undefined ? state : {
                  ...state,
                  messages: append(state.messages, enclosingMessage, {
                    name,
                    number: Number(number),
                    rule,
                    type,
                    wire: WIRE_TYPES[type] ?? "varint"
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
// Source: packages/protocol/proto/cast_channel.proto (Chromium, BSD-licensed).
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
