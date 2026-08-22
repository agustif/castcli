// Custom oxlint rules for this codebase, authored with effect-oxlint.
//
// These encode one project rule mechanically: never hand-roll something Effect
// already provides. Each rule below corresponds to a place where the original
// JavaScript version reached for a Node primitive and the Effect port should
// not.
//
// The two deliberate exceptions — `node:tls` for the Cast socket and
// `node:dgram` for mDNS — are not banned, because Effect genuinely has no
// equivalent (`effect/unstable/socket` is WebSocket-only, and there is no UDP
// module). Those live behind `src/Platform/` and are documented as such.

import { Diagnostic, Plugin, Rule, RuleContext, Visitor } from "effect-oxlint"
import { Effect } from "effect"

const noNodeChildProcess = Rule.banImport("node:child_process", {
  message:
    "Use ChildProcess/ChildProcessSpawner from effect/unstable/process instead of node:child_process."
})

const noNodeHttp = Rule.banImport("node:http", {
  message:
    "Use HttpRouter/HttpServerResponse from effect/unstable/http (served by NodeHttpServer) instead of node:http."
})

const noTimers = Rule.banCallOf(["setInterval", "setTimeout"], {
  message:
    "Use Effect.repeat with a Schedule, or Effect.sleep, instead of raw timers — they are interruptible and testable with TestClock."
})

// Known limitation: Rule.banMember matches bare identifiers only.
// `console.log` is caught, `globalThis.console.log` is not. A custom visitor
// would be needed, but oxlint's visitor API didn't fire for MemberExpression.
// Defense: all package.json files declare dependencies correctly (no devDeps
// in runtime packages), and code review catches globalThis bypasses.
const noJsonParse = Rule.banMember("JSON", ["parse"], {
  message: "Decode with Schema so the parsed shape is validated and typed."
})

const noThrow = Rule.banStatement("ThrowStatement", {
  message:
    "Fail with a Schema.TaggedError via Effect.fail instead of throwing, so the error appears in the effect's type."
})

// Control flow belongs in Effect's own combinators, which compose and stay
// total: `Match` for discriminated dispatch, `Option`/`Effect.when` for
// conditional execution, and ternaries where a plain expression will do. An
// `if` statement is a hole where none of that composition applies.
const noIf = Rule.banStatement("IfStatement", {
  message:
    "Use Match.value / Option.match / Effect.when instead of an if statement, so the branch is an expression and stays exhaustive."
})

const noPromise = Rule.banNewExpr("Promise", {
  message:
    "Model asynchrony with Effect. Wrap unavoidable callback APIs in Effect.callback at the platform boundary."
})

const noDateNow = Rule.banMember("Date", ["now"], {
  message:
    "Read time through Effect's Clock so behaviour is deterministic under TestClock."
})

const noMathRandom = Rule.banMember("Math", ["random"], {
  message: "Use Effect's Random service instead of Math.random."
})

// --- guardrails against silently-unsound JS habits ---------------------------

const noTryCatch = Rule.banStatement("TryStatement", {
  message:
    "Use Effect.try / Effect.catch so the failure is typed and appears in the effect's signature, instead of a catch block the compiler cannot see."
})

const noAwait = Rule.banStatement("AwaitExpression", {
  message:
    "Yield the Effect instead of awaiting a Promise — awaiting escapes the fiber, so interruption and the error channel are both lost."
})

// `Array.prototype.sort`, `push`, `splice` and friends mutate in place; state
// that other fibers can observe must go through Ref.
const noMutatingArray = Rule.banCallOfMember("Array", ["sort", "reverse"], {
  message: "Use toSorted/toReversed: in-place mutation is not safe to share across fibers."
})

const noProcessExit = Rule.banCallOfMember("process", ["exit"], {
  message:
    "Let the runtime finish: exiting the process directly skips scope finalizers, so child processes and sockets leak."
})

const noProcessEnv = Rule.banMember("process", ["env"], {
  message: "Read configuration through effect/Config so it is typed, validated and documented."
})

const noConsole = Rule.banMember("console", ["log", "error", "warn", "info", "debug"], {
  message:
    "Use Console for user-facing output and Effect.log* for diagnostics, so output respects the configured logger and log level."
})

const noFetch = Rule.banCallOf(["fetch"], {
  message: "Use HttpClient from effect/unstable/http, which carries retries, tracing and typed errors."
})

const noNodeFs = Rule.banImport((source) => source === "node:fs" || source === "node:fs/promises", {
  message: "Use FileSystem from effect, so file access is mockable and errors are typed."
})

// --- adversarial rules: things that compile but quietly stop being Effect ----

// `decodeSync` and friends throw on failure. A throw inside an Effect becomes a
// defect rather than a typed error, so the failure vanishes from the signature
// and no caller can handle it.
const noSchemaSync = Rule.banCallOfMember(
  "Schema",
  ["decodeSync", "encodeSync", "decodeUnknownSync", "encodeUnknownSync"],
  {
    message:
      "Use decodeEffect/encodeEffect (or the Option variants). The *Sync forms throw, turning a typed failure into a defect."
  }
)

// Running the runtime from inside library code escapes the surrounding fiber:
// interruption, spans and services all stop at that boundary.
const noRunSync = Rule.banCallOfMember("Effect", ["runSync", "runPromise", "runFork"], {
  message:
    "Do not run the runtime inside library code — return the Effect and let the entry point run it once."
})

// Discarding the error channel is almost always a bug in disguise: the code
// keeps going with no evidence anything failed.
const noSwallowedErrors = Rule.banCallOfMember("Effect", ["ignore", "ignoreLogged"], {
  message:
    "Do not discard failures. Handle them, log them with Effect.logError, or let them propagate."
})

// `Effect.orDie` converts a typed error into a defect, which is the opposite of
// what the error channel is for.
const noOrDie = Rule.banCallOfMember("Effect", ["orDie", "orDieWith"], {
  message: "Keep the error typed rather than converting it into a defect with orDie."
})

// --- no escape hatches ---------------------------------------------------
//
// A cast and a non-null assertion are the same move: telling the compiler to
// stop checking. Where a value genuinely arrives untyped, decode it with a
// Schema — that produces the same narrowing with a runtime guarantee behind it.

// `as const` is not an escape hatch — it narrows a literal's type without
// telling the compiler to stop checking anything — so it is allowed. Every
// other assertion is banned.
const noAsCast = Rule.define({
  name: "no-as-cast",
  meta: Rule.meta({
    type: "problem",
    description: "Assert nothing; decode with a Schema or narrow with Option/Match"
  }),
  create: function*() {
    const ctx = yield* RuleContext
    // Built with Visitor.on rather than an object literal: the visitor map's
    // keys are optional, which a concrete object cannot satisfy under
    // exactOptionalPropertyTypes.
    return Visitor.on("TSAsExpression", (node) => {
      // `as const` reads as a TSTypeReference whose type name is the
      // identifier `const`.
      const annotation = node.typeAnnotation
      const isAsConst = annotation.type === "TSTypeReference" &&
        annotation.typeName.type === "Identifier" &&
        annotation.typeName.name === "const"
      return isAsConst ? Effect.void : ctx.report(
        Diagnostic.make({
          node,
          message:
            "Do not assert a type. Decode with a Schema, or narrow with Option/Match, so the narrowing is backed by a runtime check."
        })
      )
    })
  }
})

const noNonNull = Rule.banStatement("TSNonNullExpression", {
  message:
    "Do not assert non-null. Use Array.get / Option so the absent case is handled rather than assumed."
})

const noAnyType = Rule.banStatement("TSAnyKeyword", {
  message: "`any` disables checking entirely. Use `unknown` and decode it, or name the real type."
})

// Enabled only for packages/domain via .oxlintrc overrides. The vocabulary
// package must not reach sideways or upward: everything else depends on it, so
// anything it imports becomes a dependency of the entire workspace.
//
// dependency-cruiser cannot catch this one — `@castcli/protocol` is not a
// declared dependency of `packages/domain`, so its resolver drops the import
// entirely rather than reporting it. tsconfig `paths` still resolves it, which
// is exactly the gap this rule closes.
const noWorkspaceImport = Rule.banImport((source) => source.startsWith("@castcli/"), {
  message:
    "This package is the base of the dependency graph and must not import another workspace package."
})

export default Plugin.define({
  name: "castcli",
  specifier: "./oxlint-plugin-castcli.ts",
  rules: {
    "no-node-child-process": noNodeChildProcess,
    "no-node-http": noNodeHttp,
    "no-timers": noTimers,
    "no-json-parse": noJsonParse,
    "no-throw": noThrow,
    "no-if": noIf,
    "no-promise": noPromise,
    "no-date-now": noDateNow,
    "no-math-random": noMathRandom,
    "no-try-catch": noTryCatch,
    "no-await": noAwait,
    "no-mutating-array": noMutatingArray,
    "no-process-exit": noProcessExit,
    "no-process-env": noProcessEnv,
    "no-console": noConsole,
    "no-fetch": noFetch,
    "no-node-fs": noNodeFs,
    "no-schema-sync": noSchemaSync,
    "no-run-sync": noRunSync,
    "no-swallowed-errors": noSwallowedErrors,
    "no-or-die": noOrDie,
    "no-as-cast": noAsCast,
    "no-non-null": noNonNull,
    "no-any": noAnyType,
    "no-workspace-import": noWorkspaceImport
  }
})
