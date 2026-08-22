// AirPlay sender session: URL handoff over HTTP.
//
// This is the pull-model path: POST /play hands the device a URL, and the
// device fetches from us. Query-string parameters for Content-Location and
// Start-Position (documented contract). No FairPlay, no mirroring.

import { Effect, Option, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { AirPlayDevice, Seconds } from "@castcli/domain"

export interface PlayOptions {
  readonly contentLocation: string
  readonly startPosition?: Seconds
}

export interface PlaybackInfo {
  readonly duration: number | undefined
  readonly position: number | undefined
  readonly rate: number | undefined
  readonly readyToPlay: boolean | undefined
}

/**
 * POST /play - hand the device a URL to fetch.
 *
 * Query-string parameters (documented contract):
 * - Content-Location: URL to fetch
 * - Start-Position: optional starting position in seconds
 */
export const play = (device: AirPlayDevice, options: PlayOptions) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `http://${device.ip}:${device.port}/play`
    
    const fullUrl = `${url}?Content-Location=${encodeURIComponent(options.contentLocation)}${
      options.startPosition !== undefined
        ? `&Start-Position=${options.startPosition}`
        : ""
    }`

    yield* client.post(fullUrl)
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
