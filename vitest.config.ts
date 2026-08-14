import { defineConfig } from "vitest/config"

const pkg = (name: string) =>
  new URL(`./packages/${name}/src/index.ts`, import.meta.url).pathname

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
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
      "@castcli/platform": pkg("platform")
    }
  }
})
