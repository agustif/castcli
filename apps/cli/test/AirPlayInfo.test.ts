import { assert, describe, it } from "@effect/vitest"
import { isMacAirPlayReceiver, wantsPairPinStart } from "@castcli/domain"
import { describePairSetupRefusal, pairPinStartFromInfo } from "../src/AirPlayInfo.ts"

describe("wantsPairPinStart", () => {
  it("is true for Apple TV models", () => {
    assert.isTrue(wantsPairPinStart("AppleTV11,1"))
  })

  it("is true when model is unknown (ATV-safe default)", () => {
    assert.isTrue(wantsPairPinStart(undefined))
  })

  it("is false for macOS AirPlay Receiver", () => {
    assert.isTrue(isMacAirPlayReceiver("Mac15,9"))
    assert.isFalse(wantsPairPinStart("Mac15,9"))
    assert.isFalse(pairPinStartFromInfo({
      model: "Mac15,9",
      name: "MacBook Pro de Agusti",
      deviceID: "A2:06:D0:6D:DB:26",
      statusFlags: 516,
      features: undefined
    }))
  })
})

describe("describePairSetupRefusal", () => {
  it("names Mac ACL instead of the ATV pin-start socket", () => {
    const message = describePairSetupRefusal({
      infoStatus: 200,
      infoBytes: 1153,
      pinStartStatus: undefined,
      m2Status: 403,
      m2Bytes: 0,
      host: "192.168.1.123:7000",
      model: "Mac15,9",
      act: "2",
      skippedPinStart: true
    })
    assert.match(message, /GET \/info HTTP 200 1153 bytes/)
    assert.match(message, /pair-pin-start skipped/)
    assert.match(message, /pair-setup M2 HTTP 403 0 bytes/)
    assert.match(message, /Current User/)
    assert.notMatch(message, /pin-start socket/)
  })
})
