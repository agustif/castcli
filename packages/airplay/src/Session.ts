// AirPlay sender session: URL handoff over HTTP.
//
// This is the pull-model path: POST /play hands the device a URL, and the
// device fetches from us. No FairPlay, no mirroring. Pair-verify/HAP
// authentication can be added when needed; for now this speaks the legacy
// unauthenticated endpoints that work with emulators and may still work with
// some real devices.

import { Effect, Option } from "effect"
import { HttpClient } from "effect/unstable/http"
import { AirPlayDevice, Seconds } from "@castcli/domain"

/** Binary plist is what AirPlay wants, but for MVP we'll try URL params. */
export interface PlayOptions {
  readonly contentLocation: string
  readonly startPosition?: Seconds
}

export interface PlaybackInfo {
  readonly duration?: number
  readonly position?: number
  readonly rate?: number
  readonly readyToPlay?: boolean
}

/**
 * POST /play - hand the device a URL to fetch.
 *
 * The device becomes a pull client. Legacy endpoint; modern devices may
 * require a full AirPlay 2 session, but that needs hardware to verify.
 */
export const play = (device: AirPlayDevice, options: PlayOptions) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/play`
    
    // For MVP, pass params in URL since HTTP body API varies
    const fullUrl = `${url}?Content-Location=${encodeURIComponent(options.contentLocation)}${
      options.startPosition !== undefined
        ? `&Start-Position=${options.startPosition}`
        : ""
    }`

    yield* client.post(fullUrl).pipe(Effect.orElseSucceed(() => undefined))
  })

/** POST /scrub?position=<seconds> - seek within what is playing. */
export const scrub = (device: AirPlayDevice, position: Seconds) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/scrub?position=${position}`
    
    yield* client.post(url).pipe(Effect.orElseSucceed(() => undefined))
  })

/** POST /rate?value=<0|1> - pause (0) or resume (1). */
export const rate = (device: AirPlayDevice, value: 0 | 1) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/rate?value=${value}`
    
    yield* client.post(url).pipe(Effect.orElseSucceed(() => undefined))
  })

/** POST /stop - stop playback. */
export const stop = (device: AirPlayDevice) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/stop`
    
    yield* client.post(url).pipe(Effect.orElseSucceed(() => undefined))
  })

/** GET /playback-info - current playback state. */
export const playbackInfo = (device: AirPlayDevice): Effect.Effect<Option.Option<PlaybackInfo>, never, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/playback-info`
    
    const text = yield* client.get(url).pipe(
      Effect.flatMap((response) => response.text),
      Effect.orElseSucceed(() => "")
    )

    // Very simple plist parsing for the MVP - just extract key values
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
      } as PlaybackInfo)
      : Option.none()
  })
