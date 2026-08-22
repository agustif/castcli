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

import { Diagnostic, Plugin, Rule, RuleContext, Visitor, AST } from "effect-oxlint"
import { Effect, Option } from "effect"

const noNodeChildProcess = Rule.banImport("node:child_process", {
  message:
    "Use ChildProcess/ChildProcessSpawner from effect/unstable/process instead of node:child_process."
})

const noNodeHttp = Rule.banImport("node:http", {
  message:
    "Use HttpRouter/HttpServerResponse from effect/unstable/http (served by NodeHttpServer) instead of node:http."
})

const noTimers = Rule.define({
  name: "no-timers",
  meta: Rule.meta({
    type: "problem",
    description: "Ban setInterval, setTimeout and globalThis-prefixed versions"
  }),
  create: function*() {
    const ctx = yield* RuleContext
    const bannedTimers = new Set(["setInterval", "setTimeout"])
    return Visitor.on("CallExpression", (node) => {
      return Effect.gen(function*() {
        const callee = node.callee
        if (callee.type === "Identifier" && bannedTimers.has(callee.name)) {
          yield* ctx.report(
            Diagnostic.make({
              node,
              message:
                "Use Effect.repeat with a Schedule, or Effect.sleep, instead of raw timers — they are interruptible and testable with TestClock."
            })
          )
        }
        if (callee.type === "MemberExpression") {
          const path = AST.memberPath(callee)
          const shouldReport = Effect.suspend(() => {
            if (Option.isNone(path)) return Effect.void
            const segments = path.value
            if (
              segments.length === 2 &&
              segments[0] === "globalThis" &&
              segments[1] !== undefined &&
              bannedTimers.has(segments[1])
            ) {
              return ctx.report(
                Diagnostic.make({
                  node,
                  message:
                    "Use Effect.repeat with a Schedule, or Effect.sleep, instead of raw timers — they are interruptible and testable with TestClock."
                })
              )
            }
            return Effect.void
          })
          yield* shouldReport
        }
      })
    })
  }
})

const noJsonParse = Rule.define({
  name: "no-json-parse",
  meta: Rule.meta({
    type: "problem",
    description: "Ban JSON.parse and globalThis.JSON.parse"
  }),
  create: function*() {
    const ctx = yield* RuleContext
    return Visitor.on("MemberExpression", (node) => {
      return Effect.gen(function*() {
        const path = AST.memberPath(node)
        const shouldReport = Effect.suspend(() => {
          if (Option.isNone(path)) return Effect.void
          const segments = path.value
          if (segments.length === 2 && segments[0] === "JSON" && segments[1] === "parse") {
            return ctx.report(
              Diagnostic.make({
                node,
                message: "Decode with Schema so the parsed shape is validated and typed."
              })
            )
          }
          if (
            segments.length === 3 &&
            segments[0] === "globalThis" &&
            segments[1] === "JSON" &&
            segments[2] === "parse"
          ) {
            return ctx.report(
              Diagnostic.make({
                node,
                message: "Decode with Schema so the parsed shape is validated and typed."
              })
            )
          }
          return Effect.void
        })
        yield* shouldReport
      })
    })
  }
})

const noThrow = Rule.banStatement("ThrowStatement", {
  message:
    "Fail with a Schema.TaggedError via Effect.fail instead of throwing, so the error appears in the effect's type."
})

const noIf = Rule.banStatement("IfStatement", {
  message:
    "Use Match.value / Option.match / Effect.when instead of an if statement, so the branch is an expression and stays exhaustive."
})

const noPromise = Rule.banNewExpr("Promise", {
  message:
    "Model asynchrony with Effect. Wrap unavoidable callback APIs in Effect.callback at the platform boundary."
})

const noDateNow = Rule.define({
  name: "no-date-now",
  meta: Rule.meta({
    type: "problem",
    description: "Ban Date.now and globalThis.Date.now"
  }),
  create: function*() {
    const ctx = yield* RuleContext
    return Visitor.on("MemberExpression", (node) => {
      return Effect.gen(function*() {
        const path = AST.memberPath(node)
        const shouldReport = Effect.suspend(() => {
          if (Option.isNone(path)) return Effect.void
          const segments = path.value
          if (segments.length === 2 && segments[0] === "Date" && segments[1] === "now") {
            return ctx.report(
              Diagnostic.make({
                node,
                message:
                  "Read time through Effect's Clock so behaviour is deterministic under TestClock."
              })
            )
          }
          if (
            segments.length === 3 &&
            segments[0] === "globalThis" &&
            segments[1] === "Date" &&
            segments[2] === "now"
          ) {
            return ctx.report(
              Diagnostic.make({
                node,
                message:
                  "Read time through Effect's Clock so behaviour is deterministic under TestClock."
              })
            )
          }
          return Effect.void
        })
        yield* shouldReport
      })
    })
  }
})

const noMathRandom = Rule.define({
  name: "no-math-random",
  meta: Rule.meta({
    type: "problem",
    description: "Ban Math.random and globalThis.Math.random"
  }),
  create: function*() {
    const ctx = yield* RuleContext
    return Visitor.on("MemberExpression", (node) => {
      return Effect.gen(function*() {
        const path = AST.memberPath(node)
        const shouldReport = Effect.suspend(() => {
          if (Option.isNone(path)) return Effect.void
          const segments = path.value
          if (segments.length === 2 && segments[0] === "Math" && segments[1] === "random") {
            return ctx.report(
              Diagnostic.make({
                node,
                message: "Use Effect's Random service instead of Math.random."
              })
            )
          }
          if (
            segments.length === 3 &&
            segments[0] === "globalThis" &&
            segments[1] === "Math" &&
            segments[2] === "random"
          ) {
            return ctx.report(
              Diagnostic.make({
                node,
                message: "Use Effect's Random service instead of Math.random."
              })
            )
          }
          return Effect.void
        })
        yield* shouldReport
      })
    })
  }
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

const noProcessExit = Rule.define({
  name: "no-process-exit",
  meta: Rule.meta({
    type: "problem",
    description: "Ban process.exit and globalThis.process.exit"
  }),
  create: function*() {
    const ctx = yield* RuleContext
    return Visitor.on("CallExpression", (node) => {
      return Effect.gen(function*() {
        const callee = node.callee
        if (callee.type !== "MemberExpression") return Effect.void
        const path = AST.memberPath(callee)
        const shouldReport = Effect.suspend(() => {
          if (Option.isNone(path)) return Effect.void
          const segments = path.value
          if (segments.length === 2 && segments[0] === "process" && segments[1] === "exit") {
            return ctx.report(
              Diagnostic.make({
                node,
                message:
                  "Let the runtime finish: exiting the process directly skips scope finalizers, so child processes and sockets leak."
              })
            )
          }
          if (
            segments.length === 3 &&
            segments[0] === "globalThis" &&
            segments[1] === "process" &&
            segments[2] === "exit"
          ) {
            return ctx.report(
              Diagnostic.make({
                node,
                message:
                  "Let the runtime finish: exiting the process directly skips scope finalizers, so child processes and sockets leak."
              })
            )
          }
          return Effect.void
        })
        yield* shouldReport
      })
    })
  }
})

const noProcessEnv = Rule.define({
  name: "no-process-env",
  meta: Rule.meta({
    type: "problem",
    description: "Ban process.env and globalThis.process.env"
  }),
  create: function*() {
    const ctx = yield* RuleContext
    return Visitor.on("MemberExpression", (node) => {
      return Effect.gen(function*() {
        const path = AST.memberPath(node)
        const shouldReport = Effect.suspend(() => {
          if (Option.isNone(path)) return Effect.void
          const segments = path.value
          if (segments.length === 2 && segments[0] === "process" && segments[1] === "env") {
            return ctx.report(
              Diagnostic.make({
                node,
                message: "Read configuration through effect/Config so it is typed, validated and documented."
              })
            )
          }
          if (
            segments.length === 3 &&
            segments[0] === "globalThis" &&
            segments[1] === "process" &&
            segments[2] === "env"
          ) {
            return ctx.report(
              Diagnostic.make({
                node,
                message: "Read configuration through effect/Config so it is typed, validated and documented."
              })
            )
          }
          return Effect.void
        })
        yield* shouldReport
      })
    })
  }
})

const noConsole = Rule.define({
  name: "no-console",
  meta: Rule.meta({
    type: "problem",
    description: "Ban console methods and globalThis.console methods"
  }),
  create: function*() {
    const ctx = yield* RuleContext
    const bannedMethods = new Set(["log", "error", "warn", "info", "debug"])
    return Visitor.on("MemberExpression", (node) => {
      return Effect.gen(function*() {
        const path = AST.memberPath(node)
        const shouldReport = Effect.suspend(() => {
          if (Option.isNone(path)) return Effect.void
          const segments = path.value
          if (
            segments.length === 2 &&
            segments[0] === "console" &&
            segments[1] !== undefined &&
            bannedMethods.has(segments[1])
          ) {
            return ctx.report(
              Diagnostic.make({
                node,
                message:
                  "Use Console for user-facing output and Effect.log* for diagnostics, so output respects the configured logger and log level."
              })
            )
          }
          if (
            segments.length === 3 &&
            segments[0] === "globalThis" &&
            segments[1] === "console" &&
            segments[2] !== undefined &&
            bannedMethods.has(segments[2])
          ) {
            return ctx.report(
              Diagnostic.make({
                node,
                message:
                  "Use Console for user-facing output and Effect.log* for diagnostics, so output respects the configured logger and log level."
              })
            )
          }
          return Effect.void
        })
        yield* shouldReport
      })
    })
  }
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

// Ban runtime imports of devDependencies. Third-party modules are not followed
// by dependency-cruiser, so this rule directly checks the import source against
// the known devDependencies list from the root package.json.
const noDevDependencyInRuntime = Rule.define({
  name: "no-dev-dependency-in-runtime",
  meta: Rule.meta({
    type: "problem",
    description: "Ban runtime imports of devDependencies"
  }),
  create: function*() {
    const ctx = yield* RuleContext
    const filename = yield* Effect.map(RuleContext, (c) => c.filename)
    const isTestFile =
      filename.includes("/test/") ||
      filename.endsWith(".test.ts") ||
      filename.endsWith(".test.tsx") ||
      filename.includes("/scripts/") ||
      filename.includes("/tools/") ||
      filename.includes("vitest.config.ts") ||
      filename.includes("vitest.e2e.config.ts")

    if (isTestFile) {
      return {}
    }

    const devDeps = new Set([
      "@effect/language-service",
      "@effect/vitest",
      "@types/node",
      "dependency-cruiser",
      "effect-oxlint",
      "esbuild",
      "oxlint",
      "tsx",
      "typescript",
      "vitest"
    ])

    return Visitor.on("ImportDeclaration", (node) => {
      return Effect.gen(function*() {
        const source = AST.importSource(node)
        const basePackage = source.startsWith("@") ? source.split("/").slice(0, 2).join("/") : source.split("/")[0]

        if (basePackage !== undefined && devDeps.has(basePackage)) {
          yield* ctx.report(
            Diagnostic.make({
              node,
              message: `Runtime code must not import devDependency "${basePackage}". Move to dependencies or remove the import.`
            })
          )
        }
      })
    })
  }
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
    "no-workspace-import": noWorkspaceImport,
    "no-dev-dependency-in-runtime": noDevDependencyInRuntime
  }
})
