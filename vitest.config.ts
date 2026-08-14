import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The controller's behaviour spans minutes of virtual time; TestClock makes
    // that instant, so the real timeout only needs to cover process startup.
    testTimeout: 20_000
  }
})
