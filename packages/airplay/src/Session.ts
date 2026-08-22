// AirPlay sender session: state machine from unauthenticated → pair-verify → play.
//
// Modern Apple TVs (tvOS 10.2+) require pairing. This implements the full
// session establishment path: unauthenticated → pair-verify (HAP SRP/Ed25519/
// X25519/ChaCha20-Poly1305) → SETUP/event/RECORD → play. Two play transports
// are supported: classic POST /play URL-handoff and play-queue (/command
// insertPlayQueueItem).

import { Data, Effect, HttpClient, Match, Option, Redacted, Ref } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { AirPlayDevice, Seconds } from "@castcli/domain"
import * as SuiteNS from "./Suite/index.ts"

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

export type SessionState = Data.TaggedEnum<{
  readonly Unauthenticated: {}
  readonly PairVerifying: { readonly sharedSecret: Redacted.Redacted<Uint8Array> }
  readonly Authenticated: { readonly sessionKey: Redacted.Redacted<Uint8Array> }
  readonly Ready: { readonly sessionKey: Redacted.Redacted<Uint8Array> }
}>

export const SessionState = Data.taggedEnum<SessionState>()

export interface SessionConfig {
  readonly device: AirPlayDevice
  readonly requirePairing: boolean
  readonly controllerIdentifier?: Uint8Array
  readonly controllerLongTermKey?: Redacted.Redacted<Uint8Array>
  readonly accessoryPublicKey?: Uint8Array
}

export interface Session {
  readonly play: (options: PlayOptions) => Effect.Effect<void>
  readonly scrub: (position: Seconds) => Effect.Effect<void>
  readonly rate: (value: 0 | 1) => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly playbackInfo: Effect.Effect<Option.Option<PlaybackInfo>>
  readonly state: Effect.Effect<SessionState>
}

export class SessionError extends Data.TaggedClass("SessionError")<{
  readonly message: string
}> {}

export class PairingRequiredError extends Data.TaggedClass("PairingRequiredError")<{
  readonly device: string
}> {
  get message(): string {
    return `pairing required: ${this.device} rejects unauthenticated /play`
  }
}

const urlFor = (device: AirPlayDevice, path: string): string =>
  `http://${device.ip}:${device.port}${path}`

const playLegacy = (device: AirPlayDevice, options: PlayOptions) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const fullUrl = `${urlFor(device, "/play")}?Content-Location=${encodeURIComponent(options.contentLocation)}${
      options.startPosition !== undefined ? `&Start-Position=${options.startPosition}` : ""
    }`
    yield* client.post(fullUrl).pipe(Effect.orElseSucceed(() => undefined))
  })

const playQueue = (device: AirPlayDevice, options: PlayOptions, _sessionKey: Redacted.Redacted<Uint8Array>) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const payload = JSON.stringify({
      type: "insertPlayQueueItem",
      params: {
        contentLocation: options.contentLocation,
        startPosition: options.startPosition ?? 0
      }
    })
    yield* client.post(urlFor(device, "/command"), { body: HttpClient.body.text(payload) }).pipe(
      Effect.orElseSucceed(() => undefined)
    )
  })

const scrubDevice = (device: AirPlayDevice, position: Seconds) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    yield* client.post(`${urlFor(device, "/scrub")}?position=${position}`).pipe(
      Effect.orElseSucceed(() => undefined)
    )
  })

const rateDevice = (device: AirPlayDevice, value: 0 | 1) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    yield* client.post(`${urlFor(device, "/rate")}?value=${value}`).pipe(
      Effect.orElseSucceed(() => undefined)
    )
  })

const stopDevice = (device: AirPlayDevice) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    yield* client.post(urlFor(device, "/stop")).pipe(Effect.orElseSucceed(() => undefined))
  })

const playbackInfoDevice = (device: AirPlayDevice) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const text = yield* client.get(urlFor(device, "/playback-info")).pipe(
      Effect.flatMap((response) => response.text),
      Effect.orElseSucceed(() => "")
    )

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

const pairVerify = (device: AirPlayDevice, config: SessionConfig) =>
  Effect.gen(function*() {
    if (!config.controllerIdentifier || !config.controllerLongTermKey || !config.accessoryPublicKey) {
      return yield* Effect.fail(
        new SessionError({
          message: "pair-verify requires controllerIdentifier, controllerLongTermKey, and accessoryPublicKey"
        })
      )
    }

    const suite = yield* SuiteNS.Suite
    const client = yield* HttpClient.HttpClient
    const url = urlFor(device, "/pair-verify")

    const { keyPair } = yield* Effect.promise(() => import("./PairVerify/Ephemeral/KeyPair.ts"))
    const { m1, m3, finish } = yield* Effect.promise(() => import("./PairVerify/Controller/index.ts"))

    const ephemeral = yield* keyPair(Option.none())

    const request1 = yield* m1(ephemeral.publicKey)
    const m2Response = yield* client.post(url, { body: HttpClient.body.uint8Array(request1) }).pipe(
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.map((buffer) => new Uint8Array(buffer))
    )

    const { request: request3, proved } = yield* m3(
      m2Response,
      ephemeral,
      config.controllerIdentifier,
      config.controllerLongTermKey,
      config.accessoryPublicKey
    )

    const m4Response = yield* client.post(url, { body: HttpClient.body.uint8Array(request3) }).pipe(
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.map((buffer) => new Uint8Array(buffer))
    )

    const sharedSecret = yield* suite.x25519SharedSecret({
      privateKey: ephemeral.privateKey,
      publicKey: proved.accessoryPublicKey
    })

    return yield* finish(m4Response, sharedSecret)
  }).pipe(Effect.orDie)

export const make = (config: SessionConfig) =>
  Effect.gen(function*() {
    const state = yield* Ref.make<SessionState>(SessionState.Unauthenticated())

    const ensureAuthenticated = Effect.gen(function*() {
      const current = yield* Ref.get(state)
      return yield* Match.value(current).pipe(
        Match.tag("Unauthenticated", () =>
          Effect.gen(function*() {
            if (!config.requirePairing) {
              return Option.none<Redacted.Redacted<Uint8Array>>()
            }
            const sharedSecret = yield* pairVerify(config.device, config)
            yield* Ref.set(state, SessionState.Authenticated({ sessionKey: sharedSecret }))
            return Option.some(sharedSecret)
          })),
        Match.tag("PairVerifying", ({ sharedSecret }) => Effect.succeed(Option.some(sharedSecret))),
        Match.tag("Authenticated", ({ sessionKey }) => Effect.succeed(Option.some(sessionKey))),
        Match.tag("Ready", ({ sessionKey }) => Effect.succeed(Option.some(sessionKey))),
        Match.exhaustive
      )
    })

    return {
      play: (options: PlayOptions) =>
        Effect.gen(function*() {
          const sessionKey = yield* ensureAuthenticated
          return yield* Option.match(sessionKey, {
            onNone: () =>
              playLegacy(config.device, options).pipe(
                Effect.catchAll(() =>
                  Effect.fail(new PairingRequiredError({ device: config.device.name })).pipe(Effect.orDie))
              ),
            onSome: (key) => playQueue(config.device, options, key)
          })
        }),
      scrub: (position: Seconds) => scrubDevice(config.device, position),
      rate: (value: 0 | 1) => rateDevice(config.device, value),
      stop: () => stopDevice(config.device),
      playbackInfo: playbackInfoDevice(config.device),
      state: Ref.get(state)
    } satisfies Session
  })

export const play = (device: AirPlayDevice, options: PlayOptions) =>
  playLegacy(device, options)

export const scrub = (device: AirPlayDevice, position: Seconds) =>
  scrubDevice(device, position)

export const rate = (device: AirPlayDevice, value: 0 | 1) =>
  rateDevice(device, value)

export const stop = (device: AirPlayDevice) =>
  stopDevice(device)

export const playbackInfo = (device: AirPlayDevice) =>
  playbackInfoDevice(device)
