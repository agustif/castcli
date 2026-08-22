// Integration tests for custom oxlint rules that close security gaps
// These verify that the rules catch bypass attempts that would have slipped through

import { describe, it, expect } from "@effect/vitest"
import { Effect } from "effect"
import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

const tmpDir = "/tmp/oxlint-test"

const runLintOnCode = (code: string, filename = "test.ts"): string => {
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true })
  }
  const filePath = path.join(tmpDir, filename)
  fs.writeFileSync(filePath, code)

  return Effect.try({
    try: () =>
      execSync(`NODE_OPTIONS='--import tsx' npm run lint -- ${filePath}`, {
        cwd: "/workspace",
        encoding: "utf8",
        stdio: "pipe"
      }),
    catch: (error: any) => error.stdout + error.stderr
  }).pipe(Effect.runSync)
}

describe("prefix bypass protection", () => {
  it("should catch globalThis.console.log", () =>
    Effect.gen(function*() {
      const output = runLintOnCode("globalThis.console.log('test')")
      expect(output).toContain("no-console")
      expect(output).toContain("Use Console")
    }))

  it("should catch globalThis.console.error", () =>
    Effect.gen(function*() {
      const output = runLintOnCode("globalThis.console.error('test')")
      expect(output).toContain("no-console")
    }))

  it("should catch globalThis.JSON.parse", () =>
    Effect.gen(function*() {
      const output = runLintOnCode("globalThis.JSON.parse('{}')")
      expect(output).toContain("no-json-parse")
      expect(output).toContain("Decode with Schema")
    }))

  it("should catch globalThis.Date.now", () =>
    Effect.gen(function*() {
      const output = runLintOnCode("globalThis.Date.now()")
      expect(output).toContain("no-date-now")
      expect(output).toContain("Clock")
    }))

  it("should catch globalThis.Math.random", () =>
    Effect.gen(function*() {
      const output = runLintOnCode("globalThis.Math.random()")
      expect(output).toContain("no-math-random")
      expect(output).toContain("Random")
    }))

  it("should catch globalThis.process.env", () =>
    Effect.gen(function*() {
      const output = runLintOnCode("globalThis.process.env.HOME")
      expect(output).toContain("no-process-env")
      expect(output).toContain("Config")
    }))

  it("should catch globalThis.process.exit", () =>
    Effect.gen(function*() {
      const output = runLintOnCode("globalThis.process.exit(1)")
      expect(output).toContain("no-process-exit")
      expect(output).toContain("finalizers")
    }))

  it("should catch globalThis.setTimeout", () =>
    Effect.gen(function*() {
      const output = runLintOnCode("globalThis.setTimeout(() => {}, 100)")
      expect(output).toContain("no-timers")
      expect(output).toContain("Effect.repeat")
    }))

  it("should catch globalThis.setInterval", () =>
    Effect.gen(function*() {
      const output = runLintOnCode("globalThis.setInterval(() => {}, 100)")
      expect(output).toContain("no-timers")
      expect(output).toContain("Effect.repeat")
    }))
})

describe("devDependency detection", () => {
  it("should catch vitest import in runtime code", () =>
    Effect.gen(function*() {
      const output = runLintOnCode(
        `import { describe } from "vitest"`,
        "packages/domain/src/test.ts"
      )
      expect(output).toContain("no-dev-dependency-in-runtime")
      expect(output).toContain("devDependency")
    }))

  it("should catch @effect/vitest import in runtime code", () =>
    Effect.gen(function*() {
      const output = runLintOnCode(
        `import { it } from "@effect/vitest"`,
        "packages/domain/src/test.ts"
      )
      expect(output).toContain("no-dev-dependency-in-runtime")
    }))

  it("should allow vitest in test files", () =>
    Effect.gen(function*() {
      const output = runLintOnCode(
        `import { describe } from "vitest"`,
        "packages/domain/test/foo.test.ts"
      )
      expect(output).not.toContain("no-dev-dependency-in-runtime")
    }))
})
