import { defineConfig } from "vitest/config"

const pkg = (name: string) =>
  new URL(`./packages/${name}/src/index.ts`, import.meta.url).pathname

export default defineConfig({
  test: {
    // Apps have tests too: the CLI's state store is real I/O with real
    // failure modes, and leaving it out of the pattern hid that.
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // The end-to-end tests live in vitest.e2e.config.ts. They spawn processes
    // and encode video, so running them beside these makes both unreliable.
    exclude: ["**/node_modules/**", "**/*.e2e.test.ts"],
    // Controller behaviour spans minutes of virtual time; TestClock makes that
    // instant, so the real timeout only needs to cover process startup.
    testTimeout: 20_000
  },
  resolve: {
    alias: {
      "@castcli/domain": pkg("domain"),
      "@castcli/protocol": pkg("protocol"),
      "@castcli/media": pkg("media"),
      "@castcli/quality": pkg("quality"),
      "@castcli/platform": pkg("platform"),
      "@castcli/emulator": pkg("emulator")
    }
  }
})
