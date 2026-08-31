// AirPlay PIN resolution behavior.
//
// The full resolution logic (flag > env > prompt > error) is tested end-to-end
// via AirPlay.e2e.test.ts with AIRPLAY_PIN set. This unit test pins the
// non-interactive failure case: when stdin is not a TTY and no PIN is provided,
// the error message tells you what to do.

import { assert, describe, it } from "@effect/vitest"
import { AirPlayPinRequiredError } from "@castcli/domain"

describe("AirPlayPinRequiredError", () => {
  it("has a clear message about how to provide the PIN", () => {
    const error = new AirPlayPinRequiredError()
    assert.include(error.message, "PIN")
    assert.include(error.message, "--pin")
    assert.include(error.message, "AIRPLAY_PIN")
  })

  it("is tagged correctly for Effect error handling", () => {
    const error = new AirPlayPinRequiredError()
    assert.strictEqual(error._tag, "AirPlayPinRequiredError")
  })
})
