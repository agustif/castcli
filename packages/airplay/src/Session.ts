// AirPlay 2 sender session: HAP pair-verify then play-queue over HTTP.
//
// This is the pull-model path: the sender runs pair-verify (if pairing provided),
// then POST /command (insertPlayQueueItem) hands the device a URL, and the device
// fetches from us. No FairPlay, no mirroring, no legacy AirPlay 1 query-string /play.
//
// After pair-verify, control POSTs are encrypted with ChaCha20-Poly1305 framing.

import { Effect, Option, Redacted } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { AirPlayDevice, Seconds } from "@castcli/domain"
import * as PairVerify from "./PairVerify/index.ts"
import type { Pairing } from "./PairSetup/Controller/Pairing.ts"
import * as PlaybackInfoModule from "./PlaybackInfo/index.ts"
import * as EncryptedSession from "./EncryptedSession.ts"

export interface PlayOptions {
  readonly contentLocation: string
  readonly startPosition?: Seconds
  readonly pairing?: {
    readonly record: Pairing
    readonly controllerIdentity: {
      readonly identifier: string
      readonly keys: {
        readonly publicKey: Uint8Array
        readonly privateKey: Redacted.Redacted<Uint8Array>
      }
    }
  }
}

export type { PlaybackInfo } from "./PlaybackInfo/index.ts"
export { MalformedPlaybackInfo } from "./PlaybackInfo/index.ts"

export interface PairVerifyResult {
  readonly encryptedSession: EncryptedSession.EncryptedSession
}

/**
 * Run pair-verify exchange with the device and derive encrypted session.
 *
 * REQUIRED before any /command or /play requests on devices that require pairing.
 * Returns the encrypted session for subsequent control channel frames.
 * Fails on authentication errors.
 */
const runPairVerify = (
  device: AirPlayDevice,
  pairing: {
    readonly record: Pairing
    readonly controllerIdentity: {
      readonly identifier: string
      readonly keys: {
        readonly publicKey: Uint8Array
        readonly privateKey: Redacted.Redacted<Uint8Array>
      }
    }
  }
): Effect.Effect<PairVerifyResult, unknown, HttpClient.HttpClient | EncryptedSession.Suite> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/pair-verify`

    const { request: m1Request, ephemeralKeys } = yield* PairVerify.Controller.m1({
      ephemeral: Option.none()
    })

    const m2Response = yield* client.execute(
      HttpClientRequest.post(url, {
        body: HttpBody.uint8Array(m1Request, "application/octet-stream")
      })
    ).pipe(Effect.flatMap((response) => response.arrayBuffer))

    const m2Bytes = new Uint8Array(m2Response)

    const m3Request = yield* PairVerify.Controller.m3(m2Bytes, {
      ephemeralKeys,
      pairing: pairing.record,
      controllerIdentity: pairing.controllerIdentity
    })

    yield* client.execute(
      HttpClientRequest.post(url, {
        body: HttpBody.uint8Array(m3Request, "application/octet-stream")
      })
    )

    const { Schema } = yield* Effect.promise(() => import("effect"))
    const Tlv8 = yield* Effect.promise(() => import("./Tlv8/index.ts"))
    const Generated = yield* Effect.promise(() => import("./Generated/index.ts"))
    
    const items = yield* Schema.decodeUnknownEffect(Tlv8.Items)(m2Bytes)
    const accessoryEphemeralPublic = items.find((item: { type: number; value: Uint8Array }) => 
      item.type === Generated.TlvType.PublicKey
    )?.value
    
    yield* Effect.when(
      Effect.fail(new Error("Missing accessory ephemeral public key in M2")),
      Effect.succeed(accessoryEphemeralPublic === undefined)
    )

    const suite = yield* EncryptedSession.Suite
    const sharedSecret = yield* suite.x25519SharedSecret({
      privateKey: Redacted.make(ephemeralKeys.privateKey),
      publicKey: accessoryEphemeralPublic ?? new Uint8Array(32)
    })

    const sessionKeys = yield* EncryptedSession.deriveSessionKeys(sharedSecret)
    const encryptedSession = yield* EncryptedSession.make(sessionKeys)

    return { encryptedSession }
  })

/**
 * POST /command insertPlayQueueItem - AirPlay 2 play-queue (feature bit 33).
 *
 * Runs pair-verify first if pairing credentials are provided, then sends
 * the play command with encrypted framing. This is the modern AirPlay 2 path;
 * query-string /play (AirPlay 1) is not supported.
 * 
 * Fails closed: if pairing is provided but encryption fails, the request is not sent.
 */
export const play = (device: AirPlayDevice, options: PlayOptions) =>
  Effect.gen(function*() {
    const maybeResult = yield* Option.match(Option.fromUndefinedOr(options.pairing), {
      onNone: () => Effect.succeed(Option.none<PairVerifyResult>()),
      onSome: (pairing) => Effect.map(runPairVerify(device, pairing), Option.some)
    })

    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/command`

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>type</key><string>insertPlayQueueItem</string>
  <key>Content-Location</key><string>${options.contentLocation}</string>
  <key>Start-Position</key><real>${options.startPosition ?? 0}</real>
</dict>
</plist>`

    yield* Option.match(maybeResult, {
      onNone: () =>
        client.execute(
          HttpClientRequest.post(url, {
            body: HttpBody.text(plist, "application/x-apple-plist")
          })
        ),
      onSome: (result) =>
        Effect.gen(function*() {
          const plaintext = new TextEncoder().encode(plist)
          const encrypted = yield* EncryptedSession.encryptFrame(result.encryptedSession, plaintext)
          
          yield* client.execute(
            HttpClientRequest.post(url, {
              body: HttpBody.uint8Array(encrypted, "application/octet-stream")
            })
          )
        })
    })
  })

/** POST /scrub?position=<seconds> */
export const scrub = (device: AirPlayDevice, position: Seconds) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/scrub?position=${position}`
    yield* client.post(url)
  })

/** POST /rate?value=<0|1> */
export const rate = (device: AirPlayDevice, value: 0 | 1) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/rate?value=${value}`
    yield* client.post(url)
  })

/** POST /stop */
export const stop = (device: AirPlayDevice) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/stop`
    yield* client.post(url)
  })

/** GET /playback-info */
export const playbackInfo = (device: AirPlayDevice) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/playback-info`
    
    const response = yield* client.get(url)
    const text = yield* response.text

    return text.length > 0
      ? Option.some(yield* PlaybackInfoModule.parse(text))
      : Option.none()
  })

/** POST /setproperty - set device volume (0.0 to 1.0) */
export const setVolume = (device: AirPlayDevice, level: import("@castcli/domain").VolumeLevel) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/setproperty`
    
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>volume</key><real>${level}</real>
</dict>
</plist>`

    yield* client.execute(
      HttpClientRequest.post(url, {
        body: HttpBody.text(plist, "application/x-apple-plist")
      })
    )
  })
