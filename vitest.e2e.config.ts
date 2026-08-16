import { defineConfig } from "vitest/config"

const pkg = (name: string) =>
  new URL(`./packages/${name}/src/index.ts`, import.meta.url).pathname

// The end-to-end tests run apart from the rest, and one at a time.
//
// They spawn real processes, encode real video and bind real ports. Run
// alongside the fast suite they contend for all three, and the result was a
// suite that took five minutes and failed a test which passes in ten seconds on
// its own. Separating them keeps `npm test` quick enough to run constantly and
// makes these deterministic enough to trust.
//
// Written out rather than merged with the base config: `mergeConfig`
// concatenates arrays, so an `include` here would have been added to the base
// one — which quietly ran the whole suite again instead of these three tests.
export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000
  },
  resolve: {
    alias: {
      "@castcli/domain": pkg("domain"),
      "@castcli/protocol": pkg("protocol"),
      "@castcli/media": pkg("media"),
      "@castcli/quality": pkg("quality"),
      "@castcli/platform": pkg("platform"),
      "@castcli/emulator": pkg("emulator"),
      "@castcli/dlna": pkg("dlna"),
      "@castcli/source": pkg("source"),
      "@castcli/airplay": pkg("airplay")
    }
  }
})
