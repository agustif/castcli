// Play over the keep-alive HAP socket that pair-setup already opened.
//
// FetchHttpClient opens a new TCP connection per request. Apple TV answers
// that with HTTP 470 and an empty body, which pair-verify decodes as
// InvalidValue. The pin-start socket is the one that is allowed to talk.
//
// After pair-verify this follows pyatv AirPlayV2.play_url: NTP timing UDP,
// RTSP SETUP (timingPort + NTP), RECORD, POST /play bplist, POST /rate,
// poll /playback-info.

import { Console, Data, Duration, Effect, Layer, Match, Option, Redacted, Schema, Scope } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import type { AirPlayDevice } from "@castcli/domain"
import {
  EncryptedSession,
  GeneratedPairing,
  NodeSuite,
  PairVerify,
  Tlv8
} from "@castcli/airplay"
import type { PairHttp } from "./AirPlayPairHttp.ts"
import type { AirPlayPairing } from "./State.ts"
import * as bplist from "./bplist.ts"

import * as dgram from "node:dgram"
// import * as net from "node:net"

export class AirPlayHttpError extends Data.TaggedError("AirPlayHttpError")<{
  readonly message: string
}> {}

const cryptoLayer = Layer.provide(NodeSuite, NodeCrypto.layer)

const bplistToXml = (bytes: Uint8Array): string => {
  if (bytes.byteLength === 0) {
    return ""
  }
  try {
    return bplist.toXml(bplist.decode(bytes))
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  }
}

const wrapCommand = (innerXml: string): Uint8Array => {
  const innerPlist = bplist.fromXml(innerXml)
  const inner = bplist.encode(innerPlist)
  const wrapper: bplist.PlistDict = {
    params: {
      data: inner
    }
  }
  return bplist.encode(wrapper)
}

const streamIdFromSetup = (body: Uint8Array): string => {
  try {
    const decoded = bplist.decode(body)
    if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
      const streams = (decoded as { streams?: unknown }).streams
      if (Array.isArray(streams) && streams[0] !== null && typeof streams[0] === "object") {
        const id = (streams[0] as { streamID?: unknown }).streamID
        if (typeof id === "number" || typeof id === "string") {
          return String(id)
        }
      }
    }
  } catch {
    // fall through to XML
  }
  return /<key>streamID<\/key>\s*<integer>(\d+)<\/integer>/.exec(bplistToXml(body))?.[1] ?? ""
}

const hexHead = (bytes: Uint8Array): string =>
  Array.from(bytes.subarray(0, 64))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")

const refuseUnlessOk = (
  step: string,
  http: { readonly status: number; readonly body: Uint8Array }
) =>
  Effect.when(
    Effect.fail(
      new AirPlayHttpError({
        message: `${step} HTTP ${http.status} ${http.body.byteLength} bytes (need 200 and a HAP body)`
      })
    ),
    Effect.succeed(http.status !== 200 || http.body.byteLength < 16)
  )

const ntpStamp = (): { sec: number; frac: number } => {
  const unix = Date.now() / 1000
  const sec = (Math.floor(unix) + 2208988800) >>> 0
  const frac = Math.floor((unix % 1) * 4294967296) >>> 0
  return { sec, frac }
}

const bindTimingServer = (host: string): Effect.Effect<{ port: number; close: () => void }, AirPlayHttpError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<{ port: number; close: () => void }>((resolve, reject) => {
        const sock = dgram.createSocket("udp4")
        sock.on("message", (msg, rinfo) => {
          console.log(`timing UDP ${msg.byteLength} bytes from ${rinfo.address}:${rinfo.port} ${hexHead(msg)}`)
          if (msg.byteLength < 32) {
            return
          }
          const reply = Buffer.alloc(32)
          reply[0] = 0x80
          reply[1] = 0xd3
          reply[2] = msg[2] ?? 0
          reply[3] = msg[3] ?? 0
          msg.copy(reply, 8, 24, 32)
          const recv = ntpStamp()
          reply.writeUInt32BE(recv.sec, 16)
          reply.writeUInt32BE(recv.frac, 20)
          const send = ntpStamp()
          reply.writeUInt32BE(send.sec, 24)
          reply.writeUInt32BE(send.frac, 28)
          sock.send(reply, rinfo.port, rinfo.address)
          console.log(`timing reply to ${rinfo.address}:${rinfo.port} ${hexHead(reply)}`)
        })
        sock.on("error", (err) => reject(err))
        sock.bind(0, host, () => {
          const addr = sock.address()
          const port = typeof addr === "object" ? addr.port : 0
          console.log(`timing server bound ${host}:${port}`)
          resolve({
            port,
            close: () => {
              try {
                sock.close()
              } catch {
                // ignore
              }
            }
          })
        })
      }),
    catch: (cause) => new AirPlayHttpError({ message: `timing UDP bind: ${String(cause)}` })
  })

// Event channel derivation - not needed for this PR
// const deriveEventKeys = (sharedSecret: Redacted.Redacted<Uint8Array>) =>
//   Effect.gen(function*() {
//     const suite = yield* EncryptedSession.Suite
//     // pyatv setup_channel for EventChannel: Read/Write infos reversed because
//     // we originate the TCP connection to the receiver.
//     const writeKey = yield* suite.hkdfSha512({
//       key: sharedSecret,
//       salt: "Events-Salt",
//       info: "Events-Read-Encryption-Key"
//     })
//     const readKey = yield* suite.hkdfSha512({
//       key: sharedSecret,
//       salt: "Events-Salt",
//       info: "Events-Write-Encryption-Key"
//     })
//     return yield* EncryptedSession.make({ readKey, writeKey })
//   })

// Commented out for this PR
// const eventHttp200 = (request: string): Uint8Array => {
//   const cseq = /(?:^|\r\n)CSeq:\s*(\S+)/i.exec(request)?.[1] ?? "1"
//   const server = /(?:^|\r\n)Server:\s*(.+)/i.exec(request)?.[1]?.trim()
//   const proto = /RTSP\/1\.0/i.test(request) ? "RTSP/1.0" : "HTTP/1.1"
//   const lines = [
//     `${proto} 200 OK`,
//     "Content-Length: 0",
//     "Audio-Latency: 0",
//     `CSeq: ${cseq}`
//   ]
//   if (server !== undefined) {
//     lines.push(`Server: ${server}`)
//   }
//   return new TextEncoder().encode(lines.join("\r\n") + "\r\n\r\n")
// }

// Commented out for this PR
// const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => {
//   const out = new Uint8Array(a.byteLength + b.byteLength)
//   out.set(a, 0)
//   out.set(b, a.byteLength)
//   return out
// }

// Commented out for this PR
// const indexOfCrlf2 = (buf: Uint8Array): number => {
//   for (let i = 0; i + 3 < buf.byteLength; i++) {
//     if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
//       return i
//     }
//   }
//   return -1
// }
//
// const takeCompleteHttp = (buf: Uint8Array): { message: Uint8Array; rest: Uint8Array } | undefined => {
//   const headerEnd = indexOfCrlf2(buf)
//   if (headerEnd < 0) {
//     return undefined
//   }
//   const headerText = new TextDecoder("latin1").decode(buf.subarray(0, headerEnd))
//   const cl = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(headerText)
//   const contentLength = cl ? Number(cl[1]) : 0
//   const total = headerEnd + 4 + contentLength
//   if (buf.byteLength < total) {
//     return undefined
//   }
//   return { message: buf.subarray(0, total), rest: buf.subarray(total) }
// }

const playback = { state: "" }

// Commented out for this PR
// const xmlOfBplist = (body: Uint8Array): string => {
//   const magic = new TextDecoder("latin1").decode(body.subarray(0, Math.min(8, body.byteLength)))
//   if (magic !== "bplist00") {
//     return new TextDecoder("utf-8", { fatal: false }).decode(body)
//   }
//   const xml = bplistToXml(body)
//   const data = /<key>data<\/key>\s*<data>\s*([A-Za-z0-9+/=\s]+)<\/data>/.exec(xml)
//   if (data) {
//     const inner = Buffer.from((data[1] ?? "").replace(/\s+/g, ""), "base64")
//     if (inner.byteLength > 8) {
//       return bplistToXml(new Uint8Array(inner))
//     }
//   }
//   return xml
// }
//
// const notePlaybackState = (xml: string) => {
//   const state =
//     /<key>playbackState<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1] ??
//     /<key>name<\/key>\s*<string>(playing|paused|stopped|ended|loading|stalled)<\/string>/i.exec(xml)?.[1]
//   if (state !== undefined && state !== playback.state) {
//     playback.state = state
//     console.log(`playbackState ${state}`)
//   }
// }

// Commented out for this PR
// const logEventRequest = (message: Uint8Array) => {
//   const headerEnd = indexOfCrlf2(message)
//   const headerText = new TextDecoder("latin1").decode(message.subarray(0, Math.max(0, headerEnd)))
//   const body = headerEnd >= 0 ? message.subarray(headerEnd + 4) : new Uint8Array()
//   const first = headerText.split("\r\n")[0] ?? ""
//   const method = first.split(" ")[0] ?? "?"
//   const path = first.split(" ")[1] ?? "?"
//   const cl = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(headerText)
//   const contentLength = cl ? Number(cl[1]) : 0
//   const inner = xmlOfBplist(body)
//   notePlaybackState(inner)
//   console.log(
//     `event channel request ${method} ${path} Content-Length:${contentLength} inner=${inner.replace(/\s+/g, " ").slice(0, 300)}`
//   )
// }

// Event channel attachment - not needed for this PR (commented out)

// Event channel code commented out for this PR - not needed for basic transient pairing
// const tryEventChannel = (
//   host: string,
//   port: number,
//   sharedSecret: Redacted.Redacted<Uint8Array>
// ) =>
//   Effect.gen(function*() {
//     const eventSession = yield* deriveEventKeys(sharedSecret).pipe(Effect.provide(cryptoLayer))
//     for (let attempt = 1; attempt <= 5; attempt++) {
//       const sock = yield* Effect.tryPromise({
//         try: () =>
//           new Promise<net.Socket | undefined>((resolve) => {
//             const s = net.connect({ host, port }, () => resolve(s))
//             s.setTimeout(1500)
//             s.once("error", () => resolve(undefined))
//             s.once("timeout", () => {
//               s.destroy()
//               resolve(undefined)
//             })
//           }),
//         catch: () => undefined
//       })
//       if (sock !== undefined) {
//         sock.setTimeout(0)
//         attachEventChannel(sock, eventSession)
//         yield* Console.log(`event channel HAP ${host}:${port} attempt ${attempt}`)
//         return sock
//       }
//       yield* Console.log(`event channel refused ${host}:${port} attempt ${attempt}/5`)
//       yield* Effect.sleep(Duration.seconds(1))
//     }
//     return undefined
//   })

const catchHttp = (label: string) =>
  (cause: unknown) =>
    Effect.gen(function*() {
      yield* Console.log(`${label} failed: ${String(cause)}`)
      return { status: 0, body: new Uint8Array() }
    })

export const play = (options: {
  readonly wire: PairHttp
  readonly device: AirPlayDevice
  readonly pairing: AirPlayPairing
  readonly contentLocation: string
  readonly startPosition: number
}): Effect.Effect<void, unknown, Scope.Scope> =>
  Effect.gen(function*() {
    const isTransient = options.pairing.transient ?? false

    yield* Effect.when(
      Effect.gen(function*() {
        const suite = yield* EncryptedSession.Suite
        const ephemeralKeys = yield* suite.x25519KeyPair
        const publicKey = yield* suite.x25519PublicKey(ephemeralKeys.privateKey)
        const request = new Uint8Array(1 + 32)
        request[0] = 0x01
        request.set(publicKey, 1)
        const auth = yield* options.wire.post("/auth-setup", request)
        yield* Console.log(`auth-setup HTTP ${auth.status} ${auth.body.byteLength} bytes`)
      }).pipe(Effect.provide(cryptoLayer)),
      Effect.succeed(options.device.requiresMFiAuth)
    )

    const session = yield* Match.value(isTransient).pipe(
      Match.when(true, () =>
        Effect.gen(function*() {
          yield* Console.log("Transient session: deriving control keys from SRP shared secret (no pair-verify)")
          const srpKey = yield* Option.match(
            Option.fromNullable(options.pairing.srpSessionKey),
            {
              onNone: () => Effect.fail(new AirPlayHttpError({ 
                message: "Transient pairing missing SRP session key" 
              })),
              onSome: (key) => Effect.succeed(key)
            }
          )
          const sessionKeys = yield* EncryptedSession.deriveTransientSessionKeys(
            Redacted.make(srpKey)
          )
          return yield* EncryptedSession.make(sessionKeys)
        }).pipe(Effect.provide(cryptoLayer))
      ),
      Match.when(false, () =>
        Effect.gen(function*() {
          const { request: m1Request, ephemeralKeys } = yield* PairVerify.Controller.m1({
            ephemeral: Option.none()
          }).pipe(Effect.provide(cryptoLayer))

          const m2Http = yield* options.wire.post("/pair-verify", m1Request)
          yield* Console.log(
            `pair-verify M2 HTTP ${m2Http.status} ${m2Http.body.byteLength} bytes ${hexHead(m2Http.body)}`
          )
          yield* refuseUnlessOk("pair-verify M2", m2Http)

          const record = {
            controller: {
              identifier: new TextEncoder().encode(options.pairing.controllerIdentifier),
              publicKey: options.pairing.controllerPublicKey
            },
            accessory: {
              identifier: options.pairing.accessoryIdentifier,
              publicKey: options.pairing.accessoryPublicKey
            }
          }

          const m3Request = yield* PairVerify.Controller.m3(m2Http.body, {
            ephemeralKeys,
            pairing: record,
            controllerIdentity: {
              identifier: options.pairing.controllerIdentifier,
              keys: {
                publicKey: options.pairing.controllerPublicKey,
                privateKey: Redacted.make(options.pairing.controllerPrivateKey)
              }
            }
          }).pipe(Effect.provide(cryptoLayer))

          const m4Http = yield* options.wire.post("/pair-verify", m3Request)
          yield* Console.log(
            `pair-verify M4 HTTP ${m4Http.status} ${m4Http.body.byteLength} bytes ${hexHead(m4Http.body)}`
          )
          yield* Effect.when(
            Effect.fail(
              new AirPlayHttpError({
                message: `pair-verify M4 HTTP ${m4Http.status} ${m4Http.body.byteLength} bytes (need 200, State=4)`
              })
            ),
            Effect.succeed(m4Http.status !== 200 || m4Http.body.byteLength < 3)
          )

          const items = yield* Schema.decodeUnknownEffect(Tlv8.Items)(m2Http.body)
          const accessoryEphemeralPublic = yield* Option.match(
            Tlv8.find(items, GeneratedPairing.TlvType.PublicKey),
            {
              onNone: () =>
                Effect.fail(
                  new AirPlayHttpError({
                    message: "Missing accessory ephemeral public key in pair-verify M2"
                  })
                ),
              onSome: (value) => Effect.succeed(value)
            }
          )

          const sharedSecret = yield* Effect.gen(function*() {
            const suite = yield* EncryptedSession.Suite
            return yield* suite.x25519SharedSecret({
              privateKey: Redacted.make(ephemeralKeys.privateKey),
              publicKey: accessoryEphemeralPublic
            })
          }).pipe(Effect.provide(cryptoLayer))
          
          const sessionKeys = yield* EncryptedSession.deriveSessionKeys(sharedSecret)
          return yield* EncryptedSession.make(sessionKeys)
        }).pipe(Effect.provide(cryptoLayer))
      ),
      Match.exhaustive
    )

    yield* options.wire.enableEncryption(session)
    yield* Console.log("HAP control encryption on")

    // Session UUID for SETUP / X-Apple-Session-ID. Item UUID is separate (pyatv tvOS 26 queue).
    const uuid = crypto.randomUUID().toUpperCase()
    const sessionId = uuid
    const sessionCorrelationUUID = crypto.randomUUID().toUpperCase()
    const itemUuid = crypto.randomUUID().toUpperCase()
    const senderMacBytes = new Uint8Array(6)
    crypto.getRandomValues(senderMacBytes)
    senderMacBytes[0] = ((senderMacBytes[0] ?? 0) & 0xfc) | 0x02
    const senderMac = Array.from(senderMacBytes, (b) => b.toString(16).padStart(2, "0")).join(":").toUpperCase()
    const localIp = new URL(options.contentLocation).hostname
    const rtspSession = Math.floor(Math.random() * 0xffffffff)
    const rtspUri = `rtsp://${localIp}/${rtspSession}`
    const timing = yield* bindTimingServer(localIp)
    yield* Console.log(`timingPort ${timing.port} host ${localIp} rtsp ${rtspUri}`)
    yield* options.wire.setReadTimeout(20000)

    const toBplist = (xml: string) =>
      Effect.try({
        try: () => bplist.encode(bplist.fromXml(xml)),
        catch: (cause) => new AirPlayHttpError({ message: `bplist: ${String(cause)}` })
      })

    const apHeaders = {
      "User-Agent": "AirPlay/960.13.1",
      "X-Apple-Session-ID": sessionId,
      "X-Apple-ProtocolVersion": "1",
      "X-Apple-Stream-ID": "1"
    }

    const setupXmlNtp = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>deviceID</key><string>${senderMac}</string>
  <key>sessionUUID</key><string>${uuid}</string>
  <key>sessionCorrelationUUID</key><string>${sessionCorrelationUUID}</string>
  <key>timingPort</key><integer>${timing.port}</integer>
  <key>timingProtocol</key><string>NTP</string>
  <key>isMultiSelectAirPlay</key><true/>
  <key>groupContainsGroupLeader</key><false/>
  <key>macAddress</key><string>${senderMac}</string>
  <key>model</key><string>iPhone14,3</string>
  <key>name</key><string>castcli</string>
  <key>osBuildVersion</key><string>20F66</string>
  <key>osName</key><string>iPhone OS</string>
  <key>osVersion</key><string>16.5</string>
  <key>senderSupportsRelay</key><false/>
  <key>sourceVersion</key><string>960.13.1</string>
  <key>statsCollectionEnabled</key><false/>
</dict>
</plist>`

    const setupXmlRemote = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>deviceID</key><string>AA:BB:CC:DD:EE:FF</string>
  <key>sessionUUID</key><string>${uuid}</string>
  <key>timingProtocol</key><string>None</string>
  <key>isRemoteControlOnly</key><true/>
  <key>isMultiSelectAirPlay</key><true/>
  <key>groupContainsGroupLeader</key><false/>
  <key>macAddress</key><string>AA:BB:CC:DD:EE:FF</string>
  <key>model</key><string>iPhone14,3</string>
  <key>name</key><string>castcli</string>
  <key>osBuildVersion</key><string>20F66</string>
  <key>osName</key><string>iPhone OS</string>
  <key>osVersion</key><string>16.5</string>
  <key>senderSupportsRelay</key><false/>
  <key>sourceVersion</key><string>960.13.1</string>
  <key>statsCollectionEnabled</key><false/>
</dict>
</plist>`

    const doSetup = (label: string, xml: string, cseq: string) =>
      Effect.gen(function*() {
        const body = yield* toBplist(xml)
        yield* Console.log(`${label} bplist ${body.byteLength} bytes uri ${rtspUri}`)
        const res = yield* options.wire.exchange(
          "SETUP",
          rtspUri,
          body,
          "application/x-apple-binary-plist",
          { ...apHeaders, CSeq: cseq, "Client-Instance": apHeaders["X-Apple-Session-ID"] },
          "RTSP/1.0"
        )
        const xmlOut = bplistToXml(res.body)
        yield* Console.log(
          `${label} RTSP ${res.status} ${res.body.byteLength} bytes hex=${hexHead(res.body)} xml=${xmlOut.slice(0, 500)}`
        )
        return res
      })

    const isMacReceiver = options.device.isMacReceiver
    yield* Effect.when(
      Console.log("Mac receiver: skipping SETUP-NTP and SETUP-remote, will send only SETUP-130"),
      Effect.succeed(isMacReceiver)
    )

    const setupRes = yield* Match.value(isMacReceiver).pipe(
      Match.when(false, () => Effect.gen(function*() {
        const ntpReq = doSetup("SETUP-NTP", setupXmlNtp, "1")
        let res = yield* ntpReq.pipe(Effect.catchCause(catchHttp("SETUP-NTP")))
        yield* Effect.when(
          Effect.gen(function*() {
            const remoteReq = doSetup("SETUP-remote", setupXmlRemote, "2")
            res = yield* remoteReq.pipe(Effect.catchCause(catchHttp("SETUP-remote")))
          }),
          Effect.succeed(res.status !== 200)
        )
        return res
      })),
      Match.when(true, () => Effect.succeed({ status: 0, body: new Uint8Array() }))
    )
    yield* options.wire.setReadTimeout(8000)

    const setupXmlOut = bplistToXml(setupRes.body)
    const eventMatch = /<key>eventPort<\/key>\s*<integer>(\d+)<\/integer>/.exec(setupXmlOut)
    const eventPort = eventMatch ? Number(eventMatch[1]) : 0
    yield* Effect.when(
      Console.log(`SETUP eventPort ${eventPort}`),
      Effect.succeed(!isMacReceiver)
    )

    yield* Match.value({ setupOk: setupRes.status === 200, isMac: isMacReceiver }).pipe(
      Match.when({ setupOk: true, isMac: false }, () => Effect.gen(function*() {
        const recordReq = options.wire.exchange(
          "RECORD",
          rtspUri,
          new Uint8Array(),
          "application/octet-stream",
          { ...apHeaders, CSeq: "3" },
          "RTSP/1.0"
        )
        const recordRes = yield* recordReq.pipe(Effect.catchCause(catchHttp("RECORD")))
        yield* Console.log(`RECORD RTSP ${recordRes.status} ${recordRes.body.byteLength} bytes ${hexHead(recordRes.body)}`)
        yield* Effect.when(
          Console.log("RECORD 200 — tvOS 26 queue: GET /info, SETUP type 130, POST /command params.data"),
          Effect.succeed(recordRes.status === 200)
        )
      })),
      Match.when({ isMac: true }, () => Console.log("Mac receiver: skipping RECORD (no NTP/remote SETUP)")),
      Match.orElse(() => Console.log(`SETUP ${setupRes.status} — not sending RECORD`))
    )

    const plistHeader = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">`

    const infoRes = yield* options.wire.get("/info").pipe(Effect.catchCause(catchHttp("GET /info")))
    yield* Console.log(`GET /info HTTP ${infoRes.status} ${infoRes.body.byteLength} bytes ${bplistToXml(infoRes.body).slice(0, 200)}`)

    const rcClient = "A6B27562-B43A-4F2D-B75F-82391E250194"
    const clientUUID = crypto.randomUUID().toUpperCase()
    let streamId = ""
    yield* Match.value(isMacReceiver).pipe(
      Match.when(false, () => Effect.gen(function*() {
        const setup130Xml = `${plistHeader}
<dict>
  <key>streams</key>
  <array>
    <dict>
      <key>clientUUID</key><string>${clientUUID}</string>
      <key>clientTypeUUID</key><string>${rcClient}</string>
      <key>channelID</key><string>${senderMac}-RCS-1</string>
      <key>controlType</key><integer>1</integer>
      <key>type</key><integer>130</integer>
    </dict>
  </array>
</dict>
</plist>`
        const setup130 = yield* doSetup("SETUP-130", setup130Xml, "4").pipe(
          Effect.catchCause(catchHttp("SETUP-130"))
        )
        const setup130XmlOut = bplistToXml(setup130.body)
        streamId = streamIdFromSetup(setup130.body)
        yield* Console.log(`SETUP-130 streamID ${streamId || "MISSING"} xml=${setup130XmlOut.slice(0, 500)}`)
      })),
      Match.when(true, () => Effect.gen(function*() {
        yield* Console.log("Mac receiver: skipping SETUP-130, will use POST /play instead of play-queue")
        const playXml = `${plistHeader}
<dict>
  <key>Content-Location</key><string>${options.contentLocation}</string>
  <key>Start-Position</key><real>${options.startPosition}</real>
</dict>
</plist>`
        const playBody = yield* toBplist(playXml)
        yield* Console.log(`POST /play bplist ${playBody.byteLength} bytes`)
        const playRes = yield* options.wire.post(
          "/play",
          playBody,
          "application/x-apple-binary-plist"
        ).pipe(Effect.catchCause(catchHttp("POST /play")))
        yield* Console.log(`POST /play HTTP ${playRes.status} ${playRes.body.byteLength} bytes ${bplistToXml(playRes.body).slice(0, 500)}`)
      }))
    )

    const cmdHeaders = {
      "User-Agent": "AirPlay/870.14.1",
      "X-Apple-ProtocolVersion": "1",
      "X-Apple-Session-ID": sessionId,
      ...(streamId !== "" ? { "X-Apple-StreamID": streamId } : {})
    }

    const sendCommand = (label: string, innerXml: string) =>
      Effect.gen(function*() {
        const body = wrapCommand(innerXml)
        yield* Console.log(`${label} wrapped ${body.byteLength} bytes`)
        const res = yield* options.wire.post(
          "/command",
          body,
          "application/x-apple-binary-plist",
          cmdHeaders
        ).pipe(Effect.catchCause(catchHttp(label)))
        yield* Console.log(
          `${label} HTTP ${res.status} ${res.body.byteLength} bytes ${bplistToXml(res.body).slice(0, 400)}`
        )
        return res
      })

    yield* Effect.when(
      Effect.gen(function*() {
        const insertXml = `${plistHeader}
<dict>
  <key>type</key><string>insertPlayQueueItem</string>
  <key>item</key>
  <dict>
    <key>uuid</key><string>${itemUuid}</string>
    <key>mediaType</key><string>file</string>
    <key>Content-Location</key><string>${options.contentLocation}</string>
    <key>Start-Position-Seconds</key><real>${options.startPosition}</real>
  </dict>
</dict>
</plist>`
        const insertRes = yield* sendCommand("insertPlayQueueItem", insertXml)
        yield* Effect.when(
          Effect.gen(function*() {
            yield* sendCommand(
              "setProperty isInterestedInDateRange",
              `${plistHeader}
<dict>
  <key>type</key><string>setProperty</string>
  <key>property</key><string>isInterestedInDateRange</string>
  <key>value</key><true/>
  <key>item</key><dict><key>uuid</key><string>${itemUuid}</string></dict>
</dict>
</plist>`
            )
            yield* sendCommand(
              "setProperty actionAtItemEnd",
              `${plistHeader}
<dict>
  <key>type</key><string>setProperty</string>
  <key>property</key><string>actionAtItemEnd</string>
  <key>value</key><integer>1</integer>
</dict>
</plist>`
            )
            yield* sendCommand(
              "setRate",
              `${plistHeader}
<dict>
  <key>type</key><string>setRate</string>
  <key>rate</key><real>1</real>
</dict>
</plist>`
            )
          }),
          Effect.succeed(insertRes.status === 200)
        )
        yield* Effect.when(
          Console.log(`insertPlayQueueItem ${insertRes.status} — not sending setProperty/setRate`),
          Effect.succeed(insertRes.status !== 200)
        )
      }),
      Effect.succeed(!isMacReceiver)
    )

    yield* Effect.when(
      Effect.gen(function*() {
        yield* Console.log("Mac receiver: sending POST /rate to start playback")
        const rateXml = `${plistHeader}
<dict>
  <key>value</key><real>1.0</real>
</dict>
</plist>`
        const rateBody = yield* toBplist(rateXml)
        const rateRes = yield* options.wire.post(
          "/rate",
          rateBody,
          "application/x-apple-binary-plist"
        ).pipe(Effect.catchCause(catchHttp("POST /rate")))
        yield* Console.log(`POST /rate HTTP ${rateRes.status} ${rateRes.body.byteLength} bytes`)
      }),
      Effect.succeed(isMacReceiver)
    )

    yield* Console.log("waiting for playback to end (event playbackState)")
    let seenPlaying = false
    for (let i = 0; i < 90; i++) {
      if (i % 2 === 0) {
        const fb = yield* options.wire.post("/feedback", new Uint8Array(), "application/octet-stream", apHeaders).pipe(
          Effect.catchCause(catchHttp("POST /feedback"))
        )
        yield* Console.log(`feedback[${i}] HTTP ${fb.status} playbackState=${playback.state || "?"}`)
      }
      const state = playback.state.toLowerCase()
      if (state === "playing" || state === "likelytokeepup") {
        seenPlaying = true
      }
      if (seenPlaying && (state === "stopped" || state === "ended")) {
        yield* Console.log(`playback ended (${playback.state})`)
        break
      }
      yield* Effect.sleep(Duration.seconds(1))
    }
    if (!seenPlaying) {
      yield* Console.log(`playbackState never reached playing (last=${playback.state || "none"})`)
    }
  }).pipe(Effect.provide(cryptoLayer))
