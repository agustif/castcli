/**
 * Transient pairing session encryption tests.
 *
 * Transient pairing derives control-channel keys directly from the SRP session
 * key (K = H(S)) using SplitSetupSalt and AccessoryEncrypt-Control /
 * ControllerEncrypt-Control info strings, as specified in the HAP ADK.
 *
 * This test verifies that after transient pair-setup M4, the controller can
 * encrypt messages to the accessory and decrypt messages from the accessory.
 *
 * @since 0.1.0
 */
import { Effect, Layer, Redacted } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { describe, it, expect } from "vitest"
import * as EncryptedSession from "../../src/EncryptedSession"
import { layer } from "../../src/NodeSuite"

const TestSuite = Layer.provide(layer, NodeCrypto.layer)

describe("EncryptedSession transient pairing", () => {
  /**
   * SRP session key K from a known transient pair-setup exchange.
   * This is H(S), the 64-byte SHA-512 hash of the SRP premaster secret.
   *
   * In a real exchange:
   * - Controller sends M1 with Transient flag, B, and M1 proof
   * - Accessory responds M2 with salt, B, and M2 proof
   * - Controller sends M3 with A and M1 proof
   * - Accessory responds M4 with State=4 and M2 proof
   * - At M4, both sides derive control-channel keys from K using:
   *   - salt: "SplitSetupSalt"
   *   - info accessoryToController: "AccessoryEncrypt-Control"
   *   - info controllerToAccessory: "ControllerEncrypt-Control"
   *
   * For this test, we use a fixed K value. In production, K comes from the
   * SRP exchange in pair-setup M3.
   */
  const testSrpSessionKey = new Uint8Array(64)
  for (let i = 0; i < 64; i++) {
    testSrpSessionKey[i] = i
  }

  it("derives control-channel keys from SRP session key", () =>
    Effect.gen(function*() {
      const sessionKeys = yield* EncryptedSession.deriveTransientSessionKeys(
        Redacted.make(testSrpSessionKey)
      )

      expect(sessionKeys.readKey).toBeDefined()
      expect(sessionKeys.writeKey).toBeDefined()

      // Keys should be 32 bytes (ChaCha20-Poly1305)
      const readKeyBytes = Redacted.value(sessionKeys.readKey)
      const writeKeyBytes = Redacted.value(sessionKeys.writeKey)
      expect(readKeyBytes.byteLength).toBe(32)
      expect(writeKeyBytes.byteLength).toBe(32)

      // Keys should be different
      expect(Buffer.from(readKeyBytes).equals(Buffer.from(writeKeyBytes))).toBe(false)
    }).pipe(Effect.provide(TestSuite), Effect.runPromise))

  it("encrypts and decrypts control messages after M4", () =>
    Effect.gen(function*() {
      // Derive session keys as the controller would after receiving M4
      const sessionKeys = yield* EncryptedSession.deriveTransientSessionKeys(
        Redacted.make(testSrpSessionKey)
      )

      // Create controller session
      const controllerSession = yield* EncryptedSession.make(sessionKeys)

      // Simulate what the controller does: encrypt a control request
      // (e.g. SETUP-NTP)
      const setupRequest = new TextEncoder().encode(
        "POST /fp-setup HTTP/1.1\r\n" +
          "Content-Type: application/x-apple-binary-plist\r\n" +
          "Content-Length: 528\r\n" +
          "\r\n" +
          "... bplist payload ..."
      )

      const encrypted = yield* EncryptedSession.encryptMessage(
        controllerSession,
        setupRequest
      )

      // The encrypted message should be larger due to framing overhead
      expect(encrypted.byteLength).toBeGreaterThan(setupRequest.byteLength)

      // Now simulate the accessory side: it would have the SAME keys but
      // with readKey and writeKey swapped (accessory's writeKey = controller's readKey)
      const accessorySessionKeys = {
        readKey: sessionKeys.writeKey,  // accessory reads what controller writes
        writeKey: sessionKeys.readKey   // accessory writes what controller reads
      }
      const accessorySession = yield* EncryptedSession.make(accessorySessionKeys)

      // Accessory should be able to decrypt the controller's encrypted message
      const decryptResult = yield* EncryptedSession.decryptAvailable(
        accessorySession,
        encrypted
      )

      expect(decryptResult.plaintext).toEqual(setupRequest)
      expect(decryptResult.rest.byteLength).toBe(0)
    }).pipe(Effect.provide(TestSuite), Effect.runPromise))

  it("round-trips controller->accessory->controller", () =>
    Effect.gen(function*() {
      const sessionKeys = yield* EncryptedSession.deriveTransientSessionKeys(
        Redacted.make(testSrpSessionKey)
      )

      const controllerSession = yield* EncryptedSession.make(sessionKeys)

      const accessorySessionKeys = {
        readKey: sessionKeys.writeKey,
        writeKey: sessionKeys.readKey
      }
      const accessorySession = yield* EncryptedSession.make(accessorySessionKeys)

      // Controller encrypts a request
      const request = new TextEncoder().encode("SETUP request")
      const encryptedRequest = yield* EncryptedSession.encryptMessage(
        controllerSession,
        request
      )

      // Accessory decrypts it
      const decryptedRequest = yield* EncryptedSession.decryptAvailable(
        accessorySession,
        encryptedRequest
      )
      expect(decryptedRequest.plaintext).toEqual(request)

      // Accessory encrypts a response
      const response = new TextEncoder().encode("HTTP/1.1 200 OK")
      const encryptedResponse = yield* EncryptedSession.encryptMessage(
        accessorySession,
        response
      )

      // Controller decrypts it
      const decryptedResponse = yield* EncryptedSession.decryptAvailable(
        controllerSession,
        encryptedResponse
      )
      expect(decryptedResponse.plaintext).toEqual(response)
    }).pipe(Effect.provide(TestSuite), Effect.runPromise))
})
