// An AirPlay receiver, emulated well enough to test against.
//
// Supports pairing-required mode (like tvOS 10.2+) where unauthenticated
// /play is rejected and pair-verify must complete first.

import { Effect, Layer, Match, Option, Queue, Ref, Schema, Scope, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Brands } from "@castcli/domain"
import { Mdns } from "@castcli/platform"
import { HttpClient } from "effect/unstable/http"
import { NodeCrypto } from "@effect/platform-node"
import * as http from "node:http"

export interface AirPlayDevice {
  readonly port: Brands.Port
  readonly name: string
  readonly loaded: Effect.Effect<Option.Option<{ url: string; position: number }>>
  readonly fetched: Effect.Effect<ReadonlyArray<string>>
  readonly rate: Effect.Effect<number>
  readonly position: Effect.Effect<number>
  readonly volume: Effect.Effect<number>
  readonly accessoryKeys?: {
    readonly publicKey: Uint8Array
    readonly identifier: Uint8Array
  } | undefined
}

const bodyOf = (request: http.IncomingMessage): Effect.Effect<Uint8Array> =>
  Effect.callback<Uint8Array>((resume) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resume(Effect.succeed(new Uint8Array(Buffer.concat(chunks)))))
    request.on("error", () => resume(Effect.succeed(new Uint8Array(0))))
  })

interface Answer {
  readonly status: number
  readonly body: Uint8Array | string
  readonly contentType?: string
}

const NOT_FOUND: Answer = { status: 404, body: "" }
const FORBIDDEN: Answer = { status: 403, body: "Pairing required" }

export const make = (options: {
  readonly name?: string
  readonly advertise?: boolean
  readonly requirePairing?: boolean
  readonly requireAuthSetup?: boolean
} = {}): Effect.Effect<AirPlayDevice, PlatformError, Scope.Scope | HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const name = options.name ?? "Emulated AirPlay"
    const requirePairing = options.requirePairing ?? false
    const requireAuthSetup = options.requireAuthSetup ?? false

    const loaded = yield* Ref.make(Option.none<{ url: string; position: number }>())
    const fetched = yield* Ref.make<ReadonlyArray<string>>([])
    const rateRef = yield* Ref.make(1)
    const position = yield* Ref.make(0)
    const volume = yield* Ref.make(0.5)
    const pairVerified = yield* Ref.make(!requirePairing)
    const authSetupCompleted = yield* Ref.make(!requireAuthSetup)

    const accessoryEphemeralPrivateKey = yield* Ref.make(
      Option.none<import("effect").Redacted.Redacted<Uint8Array>>()
    )

    const controllerEphemeralPublicKey = yield* Ref.make(
      Option.none<Uint8Array>()
    )

    const encryptedSessionKeys = yield* Ref.make(
      Option.none<{ readKey: import("effect").Redacted.Redacted<Uint8Array>; writeKey: import("effect").Redacted.Redacted<Uint8Array>; readNonce: import("effect").Ref.Ref<bigint>; writeNonce: import("effect").Ref.Ref<bigint> }>()
    )

    // Generate accessory long-term Ed25519 keys for pair-verify and pair-setup
    const AirPlayForKeys = yield* Effect.promise(() => import("@castcli/airplay"))
    const suiteForKeys = yield* Effect.provide(AirPlayForKeys.Suite.Suite, Layer.provide(AirPlayForKeys.NodeSuite, NodeCrypto.layer))
    const accessoryLongtermKeys = yield* suiteForKeys.ed25519KeyPair
    const accessoryIdentifier = new TextEncoder().encode("emulator-test")

    // Create real HAP pair-setup accessory (same long-term keys as pair-verify)
    const pairSetupAccessory = yield* (requirePairing
      ? Effect.map(
          AirPlayForKeys.PairSetupAccessory.make({
            setupCode: "3939",
            pairingId: "emulator-test",
            seed: accessoryLongtermKeys.privateKey,
            attemptLimit: 100
          }).pipe(Effect.provide(Layer.provide(AirPlayForKeys.NodeSuite, NodeCrypto.layer))),
          Option.some
        )
      : Effect.succeed(Option.none())
    )

    const client = yield* HttpClient.HttpClient
    const pulls = yield* Queue.unbounded<string>()

    const pull = (url: string) =>
      Effect.gen(function*() {
        yield* Ref.update(fetched, (all) => [...all, url])
        yield* client.get(url).pipe(Effect.flatMap((r) => r.arrayBuffer))
      }).pipe(Effect.orElseSucceed(() => undefined))

    yield* Effect.forkScoped(Stream.runForEach(Stream.fromQueue(pulls), pull))

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
      () => Effect.sync(() => { server.closeAllConnections(); server.close() })
    )

    const address = server.address()
    const port = Brands.Port.make(
      address !== null && typeof address === "object" ? address.port : 7000
    )

    const handlePairSetup = (body: Uint8Array): Effect.Effect<Answer> =>
      Option.match(pairSetupAccessory, {
        onNone: () => Effect.succeed(NOT_FOUND),
        onSome: (accessory) =>
          Effect.match(
            Effect.provide(
              accessory.respond(body),
              Layer.merge(Layer.provide(AirPlayForKeys.NodeSuite, NodeCrypto.layer), NodeCrypto.layer)
            ),
            {
              onFailure: () => ({
                status: 500,
                body: "Pair-setup failed"
              } satisfies Answer),
              onSuccess: (response: Uint8Array) => ({
                status: 200,
                body: response,
                contentType: "application/octet-stream"
              } satisfies Answer)
            }
          )
      })

    const handleAuthSetup = (_body: Uint8Array): Effect.Effect<Answer> =>
      requireAuthSetup
        ? Effect.gen(function*() {
          yield* Ref.set(authSetupCompleted, true)

          const AirPlay = yield* Effect.promise(() => import("@castcli/airplay"))
          const suite = yield* Effect.provide(AirPlay.Suite.Suite, Layer.provide(AirPlay.NodeSuite, NodeCrypto.layer))

          const serverEphemeralKeys = yield* suite.x25519KeyPair
          const serverPublicKey = yield* suite.x25519PublicKey(serverEphemeralKeys.privateKey)

          const stubCertificate = new TextEncoder().encode("STUB_MFI_CERT")
          const certificateLength = new Uint8Array(4)
          certificateLength[0] = (stubCertificate.length >> 24) & 0xff
          certificateLength[1] = (stubCertificate.length >> 16) & 0xff
          certificateLength[2] = (stubCertificate.length >> 8) & 0xff
          certificateLength[3] = stubCertificate.length & 0xff

          const stubSignature = new TextEncoder().encode("STUB_SIGNATURE_DATA")

          const response = new Uint8Array(
            32 + 4 + stubCertificate.length + stubSignature.length
          )
          response.set(serverPublicKey, 0)
          response.set(certificateLength, 32)
          response.set(stubCertificate, 36)
          response.set(stubSignature, 36 + stubCertificate.length)

          return {
            status: 200,
            body: response,
            contentType: "application/octet-stream"
          } satisfies Answer
        }).pipe(Effect.orElseSucceed(() => ({ status: 500, body: "Internal error" })))
        : Effect.succeed(NOT_FOUND)

    const handlePairVerify = (body: Uint8Array): Effect.Effect<Answer> =>
      requirePairing
        ? Effect.gen(function*() {
          const AirPlay = yield* Effect.promise(() => import("@castcli/airplay"))
          const { Items } = AirPlay.Tlv8
          const { TlvType } = AirPlay.GeneratedPairing

          const items = yield* Schema.decodeUnknownEffect(Items)(body).pipe(
            Effect.orElseSucceed((): ReadonlyArray<{ type: number; value: Uint8Array }> => [])
          )
          const stateItem = items.find((item) => item.type === TlvType.State)

          return yield* Option.match(
            Option.fromNullishOr(stateItem).pipe(
              Option.filter((item): item is { type: number; value: Uint8Array } =>
                typeof item === "object" && item !== null && "value" in item && item.value instanceof Uint8Array && item.value.length > 0
              )
            ),
            {
              onNone: () => Effect.succeed({ status: 400, body: "Missing state" } satisfies Answer),
              onSome: (stateEntry) => Effect.gen(function*() {
                const pairVerifyState = stateEntry.value[0]

                return yield* Match.value(pairVerifyState).pipe(
                  Match.when(1, () => Effect.gen(function*() {
                    const controllerPubKeyEntry = items.find((entry: unknown) =>
                      typeof entry === "object" &&
                      entry !== null &&
                      "type" in entry &&
                      typeof entry.type === "number" &&
                      entry.type === TlvType.PublicKey &&
                      "value" in entry &&
                      entry.value instanceof Uint8Array
                    )

                    return yield* Option.match(
                      Option.fromNullishOr(controllerPubKeyEntry),
                      {
                        onNone: () => Effect.succeed({ status: 400, body: "Missing public key" } satisfies Answer),
                        onSome: (pubKeyEntry) => Effect.gen(function*() {
                          const controllerEphemeralPublic = yield* Match.value(pubKeyEntry).pipe(
                            Match.when(
                              { value: Match.instanceOf(Uint8Array) },
                              (entry) => Effect.succeed(entry.value)
                            ),
                            Match.orElse(() => Effect.fail(new Error("Missing public key value")))
                          )

                          yield* Ref.set(controllerEphemeralPublicKey, Option.some(controllerEphemeralPublic))
                          const suite = yield* Effect.provide(AirPlay.Suite.Suite, Layer.provide(AirPlay.NodeSuite, NodeCrypto.layer))
                          
                          // Generate accessory ephemeral X25519 keys
                          const accessoryEphemeral = yield* suite.x25519KeyPair
                          const accessoryEphemeralPublic = yield* suite.x25519PublicKey(
                            accessoryEphemeral.privateKey
                          )

                          yield* Ref.set(accessoryEphemeralPrivateKey, Option.some(accessoryEphemeral.privateKey))

                          // Derive shared secret and session key
                          const sharedSecret = yield* suite.x25519SharedSecret({
                            privateKey: accessoryEphemeral.privateKey,
                            publicKey: controllerEphemeralPublic
                          })

                          const sessionKey = yield* suite.hkdfSha512({
                            key: sharedSecret,
                            salt: "Pair-Verify-Encrypt-Salt",
                            info: "Pair-Verify-Encrypt-Info"
                          })

                          // Build verifyInfo for signing: sharedSecret + identifier + publicKey
                          const { Redacted } = yield* Effect.promise(() => import("effect"))
                          const sharedSecretBytes = Redacted.value(sharedSecret)
                          
                          const verifyInfo = new Uint8Array(
                            sharedSecretBytes.length +
                            accessoryIdentifier.length + 
                            accessoryLongtermKeys.publicKey.length
                          )
                          verifyInfo.set(sharedSecretBytes, 0)
                          verifyInfo.set(accessoryIdentifier, sharedSecretBytes.length)
                          verifyInfo.set(accessoryLongtermKeys.publicKey, sharedSecretBytes.length + accessoryIdentifier.length)

                          // Sign with accessory long-term key
                          const signature = yield* suite.ed25519Sign({
                            privateKey: accessoryLongtermKeys.privateKey,
                            message: verifyInfo
                          })

                          // Build and encrypt sub-TLV
                          const subTlv = yield* Schema.encodeEffect(Items)([
                            { type: TlvType.Identifier, value: accessoryIdentifier },
                            { type: TlvType.Signature, value: signature }
                          ])

                          const nonce = new Uint8Array(12)
                          nonce.set(new TextEncoder().encode("PV-Msg02"))

                          const { Nonce: VocabNonce } = AirPlay.PairVerifyVocabulary
                          
                          const encrypted = yield* suite.seal({
                            key: sessionKey,
                            nonce: yield* AirPlay.Suite.Nonce.label(VocabNonce.PVMsg02),
                            plaintext: subTlv,
                            associatedData: new Uint8Array()
                          })

                          // Send M2
                          const m2 = [
                            { type: TlvType.State, value: new Uint8Array([2]) },
                            { type: TlvType.PublicKey, value: accessoryEphemeralPublic },
                            { type: TlvType.EncryptedData, value: encrypted }
                          ]
                          const m2Bytes = yield* Schema.encodeEffect(Items)(m2).pipe(
                            Effect.orElseSucceed(() => new Uint8Array(0))
                          )

                          return { status: 200, body: m2Bytes, contentType: "application/octet-stream" } satisfies Answer
                        })
                      }
                    )
                  })),
                  Match.when(3, () => Effect.gen(function*() {
                    const controllerEncrypted = items.find((item) => item.type === TlvType.EncryptedData)?.value
                    
                    yield* Effect.when(
                      Effect.fail(new Error("Missing encrypted data in M3")),
                      Effect.succeed(controllerEncrypted === undefined)
                    )

                    yield* Ref.set(pairVerified, true)

                    const storedAccessoryPrivateKey = yield* Ref.get(accessoryEphemeralPrivateKey)
                    const storedControllerPublicKey = yield* Ref.get(controllerEphemeralPublicKey)

                    yield* Option.match(storedAccessoryPrivateKey, {
                      onNone: () => Effect.void,
                      onSome: (accessoryPrivKey) =>
                        Option.match(storedControllerPublicKey, {
                          onNone: () => Effect.void,
                          onSome: (controllerPubKey) =>
                            Effect.gen(function*() {
                          const AirPlayForEncryption = yield* Effect.promise(() => import("@castcli/airplay"))
                          const suiteForEncryption = yield* Effect.provide(
                            AirPlayForEncryption.Suite.Suite,
                            Layer.provide(AirPlayForEncryption.NodeSuite, NodeCrypto.layer)
                          )

                          const sharedSecretForControl = yield* suiteForEncryption.x25519SharedSecret({
                            privateKey: accessoryPrivKey,
                            publicKey: controllerPubKey
                          })

                          const { Info: GeneratedInfo, Salt: GeneratedSalt } = AirPlayForEncryption.GeneratedPairing

                          const controlReadKey = yield* suiteForEncryption.hkdfSha512({
                            key: sharedSecretForControl,
                            salt: GeneratedSalt.Control,
                            info: GeneratedInfo.ControlWrite
                          })

                          const controlWriteKey = yield* suiteForEncryption.hkdfSha512({
                            key: sharedSecretForControl,
                            salt: GeneratedSalt.Control,
                            info: GeneratedInfo.ControlRead
                          })

                          const readNonceRef = yield* Ref.make(BigInt(0))
                          const writeNonceRef = yield* Ref.make(BigInt(0))

                          yield* Ref.set(
                            encryptedSessionKeys,
                            Option.some({
                              readKey: controlReadKey,
                              writeKey: controlWriteKey,
                              readNonce: readNonceRef,
                              writeNonce: writeNonceRef
                            })
                          )
                        })
                      })
                    })

                    const m4 = [{ type: TlvType.State, value: new Uint8Array([4]) }]
                    const m4Bytes = yield* Schema.encodeEffect(Items)(m4).pipe(
                      Effect.orElseSucceed(() => new Uint8Array(0))
                    )

                    return { status: 200, body: m4Bytes, contentType: "application/octet-stream" } satisfies Answer
                  })),
                  Match.orElse(() => Effect.succeed({ status: 400, body: "Invalid state" } satisfies Answer))
                )
              })
            }
          )
        }).pipe(Effect.orElseSucceed(() => ({ status: 500, body: "Internal error" })))
        : Effect.succeed(NOT_FOUND)

    const answer = (request: http.IncomingMessage): Effect.Effect<Answer> =>
      Effect.gen(function*() {
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
        const path = url.pathname
        const method = request.method ?? "GET"
        const body = yield* bodyOf(request)

        return yield* Match.value({ path, method }).pipe(
          Match.when({ path: "/pair-setup", method: "POST" }, () => handlePairSetup(body)),
          Match.when({ path: "/pair-verify", method: "POST" }, () => handlePairVerify(body)),
          Match.when({ path: "/auth-setup", method: "POST" }, () => handleAuthSetup(body)),

          Match.when({ path: "/play", method: "POST" }, () =>
            Effect.gen(function*() {
              const verified = yield* Ref.get(pairVerified)
              return yield* (verified
                ? Effect.gen(function*() {
                  const params = url.searchParams
                  const contentLocation = params.get("Content-Location") ?? ""
                  const startPosition = Number(params.get("Start-Position") ?? "0")

                  yield* Effect.when(
                    Effect.gen(function*() {
                      yield* Ref.set(loaded, Option.some({ url: contentLocation, position: startPosition }))
                      yield* Ref.set(position, startPosition)
                      yield* Ref.set(rateRef, 1)
                      yield* Queue.offer(pulls, contentLocation)
                    }),
                    Effect.succeed(contentLocation.length > 0)
                  )

                  return { status: 200, body: "" }
                })
                : Effect.succeed(FORBIDDEN)
              )
            })),

          Match.when({ path: "/command", method: "POST" }, () =>
            Effect.gen(function*() {
              const verified = yield* Ref.get(pairVerified)
              const authSetupDone = yield* Ref.get(authSetupCompleted)
              const maybeEncryptedSession = yield* Ref.get(encryptedSessionKeys)

              return yield* (verified && authSetupDone
                ? Effect.gen(function*() {
                  const bodyText = yield* Option.match(maybeEncryptedSession, {
                    onNone: () => Effect.succeed(new TextDecoder().decode(body)),
                    onSome: (session) =>
                      Effect.gen(function*() {
                        const AirPlay = yield* Effect.promise(() => import("@castcli/airplay"))
                        const suite = yield* Effect.provide(AirPlay.Suite.Suite, Layer.provide(AirPlay.NodeSuite, NodeCrypto.layer))
                        
                        const lengthHigh = body[0] ?? 0
                        const lengthLow = body[1] ?? 0
                        const length = (lengthHigh << 8) | lengthLow
                        const payload = body.slice(2, 2 + length)
                        
                        const counter = yield* Ref.getAndUpdate(session.readNonce, (n) => n + BigInt(1))
                        const nonce = yield* AirPlay.Suite.Nonce.counter(counter)
                        
                        const decrypted = yield* suite.open({
                          key: session.readKey,
                          nonce,
                          ciphertextAndTag: payload,
                          associatedData: new Uint8Array()
                        })
                        
                        return new TextDecoder().decode(decrypted)
                      }).pipe(
                        Effect.catchTag("ForgedFrame", () => Effect.succeed(new TextDecoder().decode(body))),
                        Effect.catchTag("PlatformError", () => Effect.succeed(new TextDecoder().decode(body)))
                      )
                  })

                  const urlMatch = bodyText.match(/Content-Location.*?<string>(.*?)<\/string>/s)
                  const posMatch = bodyText.match(/Start-Position.*?<real>([\d.]+)<\/real>/s)

                  yield* Effect.when(
                    Effect.gen(function*() {
                      const contentLocation = yield* Option.match(
                        Option.fromNullishOr(urlMatch).pipe(
                          Option.flatMap((match) => Option.fromNullishOr(match[1]))
                        ),
                        {
                          onNone: () => Effect.succeed(""),
                          onSome: (contentUrl) => Effect.succeed(contentUrl)
                        }
                      )
                      const startPosition = posMatch ? Number(posMatch[1]) : 0

                      yield* Ref.set(loaded, Option.some({ url: contentLocation, position: startPosition }))
                      yield* Ref.set(position, startPosition)
                      yield* Ref.set(rateRef, 1)
                      yield* Queue.offer(pulls, contentLocation)
                    }),
                    Effect.succeed(urlMatch !== null && urlMatch[1] !== undefined)
                  )

                  return { status: 200, body: "" }
                })
                : Effect.succeed(FORBIDDEN)
              )
            })),

          Match.when({ path: "/scrub", method: "POST" }, () =>
            Effect.gen(function*() {
              const positionParam = url.searchParams.get("position")
              yield* Effect.when(
                Effect.gen(function*() {
                  yield* Ref.set(position, Number(positionParam))
                }),
                Effect.succeed(positionParam !== null)
              )
              return { status: 200, body: "" }
            })),

          Match.when({ path: "/rate", method: "POST" }, () =>
            Effect.gen(function*() {
              const value = url.searchParams.get("value")
              yield* Effect.when(
                Effect.gen(function*() {
                  yield* Ref.set(rateRef, Number(value))
                }),
                Effect.succeed(value !== null)
              )
              return { status: 200, body: "" }
            })),

          Match.when({ path: "/stop", method: "POST" }, () =>
            Effect.gen(function*() {
              yield* Ref.set(rateRef, 0)
              yield* Ref.set(position, 0)
              return { status: 200, body: "" }
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
              return { status: 200, body: plist, contentType: "text/x-apple-plist+xml" }
            })),

          Match.when({ path: "/server-info", method: "GET" }, () =>
            Effect.succeed({
              status: 200,
              body: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>model</key><string>Emulator</string>
  <key>deviceid</key><string>AA:BB:CC:DD:EE:FF</string>
  <key>features</key><integer>${requireAuthSetup ? "0x8000000000001" : "0x1"}</integer>
  <key>srcvers</key><string>220.68</string>
</dict>
</plist>`,
              contentType: "text/x-apple-plist+xml"
            })),

          Match.when({ path: "/setproperty", method: "POST" }, () =>
            Effect.gen(function*() {
              const bodyText = new TextDecoder().decode(body)
              const volumeMatch = bodyText.match(/<key>volume<\/key>\s*<real>([\d.]+)<\/real>/)
              
              yield* Effect.when(
                Effect.gen(function*() {
                  const level = yield* Option.match(
                    Option.fromNullishOr(volumeMatch).pipe(
                      Option.flatMap((match) => Option.fromNullishOr(match[1]))
                    ),
                    {
                      onNone: () => Effect.succeed(0),
                      onSome: (levelStr) => Effect.succeed(Number(levelStr))
                    }
                  )
                  yield* Ref.set(volume, level)
                }),
                Effect.succeed(volumeMatch !== null)
              )
              
              return { status: 200, body: "" }
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
            Match.value(written.body).pipe(
              Match.when(Match.string, (str) => response.end(str)),
              Match.orElse((buf) => response.end(Buffer.from(buf)))
            )
          })))
    )

    yield* Effect.when(
      Mdns.advertiseAirPlay({
        name,
        port,
        ...(options.requirePairing !== undefined ? { requirePairing: options.requirePairing } : {})
      }),
      Effect.succeed(options.advertise === true)
    )

    const deviceResult: AirPlayDevice = {
      port,
      name,
      loaded: Ref.get(loaded),
      fetched: Ref.get(fetched),
      rate: Ref.get(rateRef),
      position: Ref.get(position),
      volume: Ref.get(volume),
      ...(requirePairing
        ? {
          accessoryKeys: {
            publicKey: accessoryLongtermKeys.publicKey,
            identifier: accessoryIdentifier
          }
        }
        : {})
    }
    
    return deviceResult
  })
