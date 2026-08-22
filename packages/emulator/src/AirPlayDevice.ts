// An AirPlay receiver, emulated well enough to test against.
//
// Two modes: permissive (accepts unauthenticated /play for backward compat)
// and pairing-required (rejects unauthenticated /play, requires pair-verify).
// The critical behavior: it *pulls* the media over HTTP, exactly as an Apple
// TV does.

import { Data, Effect, Match, Option, Queue, Ref, Redacted, Schema, Scope, Stream } from "effect"
import { Brands } from "@castcli/domain"
import { HttpClient } from "effect/unstable/http"
import { Mdns } from "@castcli/platform"
import * as http from "node:http"

export interface AirPlayDevice {
  readonly port: Brands.Port
  readonly name: string
  /** What /play was given, once it has been. */
  readonly loaded: Effect.Effect<Option.Option<{ url: string; position: number }>>
  /** Every URL this device pulled, in order. */
  readonly fetched: Effect.Effect<ReadonlyArray<string>>
  readonly rate: Effect.Effect<number>
  readonly position: Effect.Effect<number>
  /** Whether this device completed pair-verify successfully. */
  readonly pairVerified: Effect.Effect<boolean>
}

type PairingMode = Data.TaggedEnum<{
  readonly Permissive: {}
  readonly Required: {
    readonly accessoryIdentifier: Uint8Array
    readonly accessoryLongTermKey: Redacted.Redacted<Uint8Array>
    readonly accessoryPublicKey: Uint8Array
    readonly trustedControllers: Map<string, Uint8Array>
  }
}>

const PairingMode = Data.taggedEnum<PairingMode>()

const bodyOf = (request: http.IncomingMessage): Effect.Effect<Uint8Array> =>
  Effect.callback<Uint8Array>((resume) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on("end", () => resume(Effect.succeed(Buffer.concat(chunks))))
    request.on("error", () => resume(Effect.succeed(new Uint8Array())))
  })

interface Answer {
  readonly status: number
  readonly body: Uint8Array | string
  readonly contentType?: string
}

const NOT_FOUND: Answer = { status: 404, body: "" }
const FORBIDDEN: Answer = { status: 403, body: "" }

export const make = (options: {
  readonly name?: string
  readonly advertise?: boolean
  readonly requirePairing?: boolean
} = {}): Effect.Effect<AirPlayDevice, never, Scope.Scope | HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const name = options.name ?? "Emulated AirPlay"

    const loaded = yield* Ref.make(Option.none<{ url: string; position: number }>())
    const fetched = yield* Ref.make<ReadonlyArray<string>>([])
    const rateRef = yield* Ref.make(1)
    const position = yield* Ref.make(0)
    const verified = yield* Ref.make(false)

    const mode = yield* Effect.gen(function*() {
      if (!options.requirePairing) {
        return PairingMode.Permissive()
      }
      const AirPlay = yield* Effect.promise(() => import("@castcli/airplay"))
      const suite = yield* AirPlay.Suite.Suite
      const identity = yield* suite.ed25519KeyPair
      const identifier = new TextEncoder().encode("AA:BB:CC:DD:EE:FF")
      const publicKey = yield* suite.ed25519PublicKey(identity.privateKey)
      return PairingMode.Required({
        accessoryIdentifier: identifier,
        accessoryLongTermKey: identity.privateKey,
        accessoryPublicKey: publicKey,
        trustedControllers: new Map()
      })
    })

    const client = yield* HttpClient.HttpClient

    const pulls = yield* Queue.unbounded<string>()

    const pull = (url: string) =>
      Effect.gen(function*() {
        const response = yield* client.get(url)
        yield* response.arrayBuffer
        yield* Ref.update(fetched, (all) => [...all, url])
      })

    yield* Effect.forkScoped(
      Stream.runForEach(
        Stream.fromQueue(pulls),
        (url) => pull(url).pipe(Effect.orElseSucceed(() => undefined))
      )
    )

    const server = http.createServer()
    const requests = yield* Queue.unbounded<{
      request: http.IncomingMessage
      response: http.ServerResponse
    }>()

    server.on("request", (request, response) => {
      Queue.offerUnsafe(requests, { request, response })
    })

    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.listen(0, "127.0.0.1", () => resume(Effect.void))
      }),
      () =>
        Effect.sync(() => {
          server.closeAllConnections()
          server.close()
        })
    )

    const address = server.address()
    const port = Brands.Port.make(
      address !== null && typeof address === "object" ? address.port : 7000
    )

    const handlePairVerify = (body: Uint8Array, pairingConfig: {
      readonly accessoryIdentifier: Uint8Array
      readonly accessoryLongTermKey: Redacted.Redacted<Uint8Array>
      readonly accessoryPublicKey: Uint8Array
      readonly trustedControllers: Map<string, Uint8Array>
    }): Effect.Effect<Answer> =>
      Effect.gen(function*() {
        const AirPlay = yield* Effect.promise(() => import("@castcli/airplay"))
        const suite = yield* AirPlay.Suite.Suite
        const items = yield* Effect.promise(() => AirPlay.Tlv8.Items).pipe(
          Effect.flatMap((Items) => Schema.decodeUnknownEffect(Items)(body))
        )
        const { TlvType, PairingError } = AirPlay.GeneratedPairing
        const { find } = AirPlay.Tlv8
        const { required, exactly } = AirPlay.PairVerify
        const { Salt, Info, Nonce: NonceLabel } = AirPlay.PairVerifyVocabulary

        const stateBytes = yield* required(items, TlvType.State, "kTLVType_State")
        const state = stateBytes[0]

        if (state === 1) {
          const controllerEphemeralPublic = yield* exactly(items, TlvType.PublicKey, "kTLVType_PublicKey", 32)
          const accessoryEphemeral = yield* suite.x25519KeyPair
          const sharedSecret = yield* suite.x25519SharedSecret({
            privateKey: accessoryEphemeral.privateKey,
            publicKey: controllerEphemeralPublic
          })
          const sessionKey = yield* suite.hkdfSha512({
            key: sharedSecret,
            salt: Salt.PairVerifyEncrypt,
            info: Info.PairVerifyEncrypt
          })

          const accessoryInfo = new Uint8Array([
            ...accessoryEphemeral.publicKey,
            ...pairingConfig.accessoryIdentifier,
            ...controllerEphemeralPublic
          ])
          const accessorySignature = yield* suite.ed25519Sign({
            privateKey: pairingConfig.accessoryLongTermKey,
            message: accessoryInfo
          })

          const Items = yield* Effect.promise(() => AirPlay.Tlv8.Items)
          const subTlvPlaintext = yield* Schema.encodeEffect(Items)([
            { type: TlvType.Identifier, value: pairingConfig.accessoryIdentifier },
            { type: TlvType.Signature, value: accessorySignature }
          ])

          const nonce = yield* AirPlay.Suite.Nonce.label(NonceLabel.PVMsg02)
          const encrypted = yield* suite.seal({
            key: sessionKey,
            nonce,
            plaintext: subTlvPlaintext,
            associatedData: new Uint8Array()
          })

          const m2 = yield* Schema.encodeEffect(Items)([
            { type: TlvType.State, value: new Uint8Array([2]) },
            { type: TlvType.PublicKey, value: accessoryEphemeral.publicKey },
            { type: TlvType.EncryptedData, value: encrypted }
          ])

          return { status: 200, body: m2, contentType: "application/octet-stream" }
        }

        if (state === 3) {
          yield* Ref.set(verified, true)
          const Items = yield* Effect.promise(() => AirPlay.Tlv8.Items)
          const m4 = yield* Schema.encodeEffect(Items)([
            { type: TlvType.State, value: new Uint8Array([4]) }
          ])
          return { status: 200, body: m4, contentType: "application/octet-stream" }
        }

        const Items = yield* Effect.promise(() => AirPlay.Tlv8.Items)
        const errorResponse = yield* Schema.encodeEffect(Items)([
          { type: TlvType.State, value: new Uint8Array([state + 1]) },
          { type: TlvType.Error, value: new Uint8Array([PairingError.Unknown]) }
        ])
        return { status: 200, body: errorResponse, contentType: "application/octet-stream" }
      }).pipe(Effect.orElseSucceed(() => ({ status: 500, body: "", contentType: "text/plain" })))


    const answer = (request: http.IncomingMessage): Effect.Effect<Answer> =>
      Effect.gen(function*() {
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
        const path = url.pathname
        const method = request.method ?? "GET"
        const body = yield* bodyOf(request)

        return yield* Match.value({ path, method }).pipe(
          Match.when({ path: "/pair-verify", method: "POST" }, () =>
            Match.value(mode).pipe(
              Match.tag("Permissive", () => Effect.succeed(NOT_FOUND)),
              Match.tag("Required", (config) => handlePairVerify(body, config)),
              Match.exhaustive
            )),

          Match.when({ path: "/play", method: "POST" }, () =>
            Effect.gen(function*() {
              const isVerified = yield* Ref.get(verified)
              const requiresPairing = Match.value(mode).pipe(
                Match.tag("Permissive", () => false),
                Match.tag("Required", () => true),
                Match.exhaustive
              )

              if (requiresPairing && !isVerified) {
                return FORBIDDEN
              }

              const params = url.searchParams
              const contentLocation = params.get("Content-Location") ?? ""
              const startPosition = Number(params.get("Start-Position") ?? "0")

              yield* Ref.set(loaded, Option.some({ url: contentLocation, position: startPosition }))
              yield* Ref.set(position, startPosition)
              yield* Ref.set(rateRef, 1)

              yield* Effect.when(
                Queue.offer(pulls, contentLocation),
                Effect.succeed(contentLocation.length > 0)
              )

              return { status: 200, body: "", contentType: "text/plain" } satisfies Answer
            })),

          Match.when({ path: "/command", method: "POST" }, () =>
            Effect.gen(function*() {
              const isVerified = yield* Ref.get(verified)
              const requiresPairing = Match.value(mode).pipe(
                Match.tag("Permissive", () => false),
                Match.tag("Required", () => true),
                Match.exhaustive
              )

              if (requiresPairing && !isVerified) {
                return FORBIDDEN
              }

              const text = new TextDecoder().decode(body)
              const command = JSON.parse(text) as { type: string; params?: { contentLocation?: string; startPosition?: number } }

              if (command.type === "insertPlayQueueItem" && command.params) {
                const contentLocation = command.params.contentLocation ?? ""
                const startPosition = command.params.startPosition ?? 0

                yield* Ref.set(loaded, Option.some({ url: contentLocation, position: startPosition }))
                yield* Ref.set(position, startPosition)
                yield* Ref.set(rateRef, 1)

                yield* Effect.when(
                  Queue.offer(pulls, contentLocation),
                  Effect.succeed(contentLocation.length > 0)
                )
              }

              return { status: 200, body: "", contentType: "text/plain" } satisfies Answer
            })),

          Match.when({ path: "/scrub", method: "POST" }, () =>
            Effect.gen(function*() {
              const positionParam = url.searchParams.get("position")
              yield* Option.match(Option.fromNullishOr(positionParam), {
                onNone: () => Effect.void,
                onSome: (value) => Ref.set(position, Number(value))
              })
              return { status: 200, body: "", contentType: "text/plain" } satisfies Answer
            })),

          Match.when({ path: "/rate", method: "POST" }, () =>
            Effect.gen(function*() {
              const value = url.searchParams.get("value")
              yield* Option.match(Option.fromNullishOr(value), {
                onNone: () => Effect.void,
                onSome: (v) => Ref.set(rateRef, Number(v))
              })
              return { status: 200, body: "", contentType: "text/plain" } satisfies Answer
            })),

          Match.when({ path: "/stop", method: "POST" }, () =>
            Effect.gen(function*() {
              yield* Ref.set(rateRef, 0)
              yield* Ref.set(position, 0)
              return { status: 200, body: "", contentType: "text/plain" } satisfies Answer
            })),

          Match.when({ path: "/playback-info", method: "GET" }, () =>
            Effect.gen(function*() {
              const currentRate = yield* Ref.get(rateRef)
              const currentPosition = yield* Ref.get(position)
              const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>duration</key><real>0</real>
  <key>position</key><real>${currentPosition}</real>
  <key>rate</key><real>${currentRate}</real>
  <key>readyToPlay</key><true />
</dict>
</plist>`
              return { status: 200, body: plist, contentType: "text/x-apple-plist+xml" } satisfies Answer
            })),

          Match.orElse(() => Effect.succeed(NOT_FOUND))
        )
      })

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(requests), ({ request, response }) =>
        Effect.flatMap(answer(request), (written) =>
          Effect.sync(() => {
            response.writeHead(written.status, {
              "content-type": written.contentType ?? "text/plain"
            })
            response.end(typeof written.body === "string" ? written.body : Buffer.from(written.body))
          })))
    )

    yield* Effect.when(
      Mdns.advertiseAirPlay({ name, port }),
      Effect.succeed(options.advertise === true)
    )

    return {
      port,
      name,
      loaded: Ref.get(loaded),
      fetched: Ref.get(fetched),
      rate: Ref.get(rateRef),
      position: Ref.get(position),
      pairVerified: Ref.get(verified)
    } satisfies AirPlayDevice
  })
