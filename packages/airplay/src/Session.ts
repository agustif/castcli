// AirPlay 2 sender session: HAP pair-verify then play-queue over HTTP.
//
// This is the pull-model path: the sender runs pair-verify (if pairing provided),
// then POST /command (insertPlayQueueItem) hands the device a URL, and the device
// fetches from us. No FairPlay, no mirroring, no legacy AirPlay 1 query-string /play.

import { Effect, Option, Redacted } from "effect"
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { AirPlayDevice, Seconds } from "@castcli/domain"
import * as PairVerify from "./PairVerify/index.ts"
import type { Pairing } from "./PairSetup/Controller/Pairing.ts"

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

export interface PlaybackInfo {
  readonly duration: number | undefined
  readonly position: number | undefined
  readonly rate: number | undefined
  readonly readyToPlay: boolean | undefined
}

/**
 * Run pair-verify exchange with the device.
 *
 * REQUIRED before any /command or /play requests on devices that require pairing.
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
) =>
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

    const m3Request = yield* PairVerify.Controller.m3(new Uint8Array(m2Response), {
      ephemeralKeys,
      pairing: pairing.record,
      controllerIdentity: pairing.controllerIdentity
    })

    yield* client.execute(
      HttpClientRequest.post(url, {
        body: HttpBody.uint8Array(m3Request, "application/octet-stream")
      })
    )
  })

/**
 * POST /command insertPlayQueueItem - AirPlay 2 play-queue (feature bit 33).
 *
 * Runs pair-verify first if pairing credentials are provided, then sends
 * the play command. This is the modern AirPlay 2 path; query-string /play
 * (AirPlay 1) is not supported.
 */
export const play = (device: AirPlayDevice, options: PlayOptions) =>
  Effect.gen(function*() {
    yield* Option.match(Option.fromUndefinedOr(options.pairing), {
      onNone: () => Effect.void,
      onSome: (pairing) => runPairVerify(device, pairing)
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

    yield* client.execute(
      HttpClientRequest.post(url, {
        body: HttpBody.text(plist, "application/x-apple-plist")
      })
    )
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

    const duration = text.match(/<key>duration<\/key>\s*<real>([\d.]+)<\/real>/)
    const position = text.match(/<key>position<\/key>\s*<real>([\d.]+)<\/real>/)
    const rateMatch = text.match(/<key>rate<\/key>\s*<real>([\d.]+)<\/real>/)
    const ready = text.match(/<key>readyToPlay<\/key>\s*<(true|false)\s*\/>/)

    return text.length > 0
      ? Option.some({
        duration: duration ? Number(duration[1]) : undefined,
        position: position ? Number(position[1]) : undefined,
        rate: rateMatch ? Number(rateMatch[1]) : undefined,
        readyToPlay: ready ? ready[1] === "true" : undefined
      })
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
