// AirPlayPairing persistence: keys must round-trip as Uint8Array.
//
// The bug: Schema.Uint8Array encoded as {0: 197, 1: 92, ...} in JSON,
// which cannot decode back. Schema.Uint8ArrayFromBase64 fixes it.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { AirPlayPairing, Remembered } from "../src/State.ts"
import { Ipv4 } from "@castcli/domain"

describe("AirPlayPairing persistence", () => {
  it("round-trips 32-byte keys through JSON encode/decode", () =>
    Effect.gen(function*() {
      const controllerPublic = new Uint8Array(32)
      const controllerPrivate = new Uint8Array(32)
      const accessoryIdentifier = new Uint8Array(16)
      const accessoryPublic = new Uint8Array(32)
      
      // Fill with recognizable test data
      for (let i = 0; i < 32; i++) {
        controllerPublic[i] = i
        controllerPrivate[i] = i + 100
        accessoryPublic[i] = i + 200
      }
      for (let i = 0; i < 16; i++) {
        accessoryIdentifier[i] = i + 50
      }

      const pairing = new AirPlayPairing({
        deviceIp: Ipv4.make("192.168.1.100"),
        deviceId: "AA:BB:CC:DD:EE:FF",
        controllerIdentifier: "test-controller-id",
        controllerPublicKey: controllerPublic,
        controllerPrivateKey: controllerPrivate,
        accessoryIdentifier,
        accessoryPublicKey: accessoryPublic
      })

      const state = new Remembered({
        positions: {},
        airplayPairings: { "test-key": pairing }
      })

      // Encode to JSON string via Schema.fromJsonString
      const codec = Schema.fromJsonString(Remembered)
      const encode = Schema.encodeEffect(codec)
      const decode = Schema.decodeEffect(codec)
      
      const jsonString = yield* encode(state)
      const decoded = yield* decode(jsonString)

      // Verify pairing round-tripped
      const decodedPairing = decoded.airplayPairings?.["test-key"]
      
      const pairing = yield* Option.match(Option.fromNullishOr(decodedPairing), {
        onNone: () => Effect.fail(new Error("Pairing not found after decode")),
        onSome: (p) => Effect.succeed(p)
      })

      assert.strictEqual(pairing.deviceIp, "192.168.1.100")
      assert.strictEqual(pairing.deviceId, "AA:BB:CC:DD:EE:FF")
      assert.strictEqual(pairing.controllerIdentifier, "test-controller-id")
      
      assert.strictEqual(pairing.controllerPublicKey.length, 32)
      assert.strictEqual(pairing.controllerPrivateKey.length, 32)
      assert.strictEqual(pairing.accessoryIdentifier.length, 16)
      assert.strictEqual(pairing.accessoryPublicKey.length, 32)

      for (let i = 0; i < 32; i++) {
        assert.strictEqual(
          pairing.controllerPublicKey[i],
          i,
          `controllerPublicKey[${i}] mismatch`
        )
        assert.strictEqual(
          pairing.controllerPrivateKey[i],
          i + 100,
          `controllerPrivateKey[${i}] mismatch`
        )
        assert.strictEqual(
          pairing.accessoryPublicKey[i],
          i + 200,
          `accessoryPublicKey[${i}] mismatch`
        )
      }
      
      for (let i = 0; i < 16; i++) {
        assert.strictEqual(
          pairing.accessoryIdentifier[i],
          i + 50,
          `accessoryIdentifier[${i}] mismatch`
        )
      }

      // JSON should be base64, not object with numeric keys
      assert.notInclude(jsonString, '"0":')
      assert.notInclude(jsonString, '"1":')
      assert.include(jsonString, '"controllerPublicKey"')
      assert.include(jsonString, '"controllerPrivateKey"')
    }).pipe(Effect.runPromise))
})
