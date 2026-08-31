// One TCP connection for pair-setup, pair-verify, then HAP-encrypted HTTP.
//
// Apple TV authorizes pair-setup on the socket that called pair-pin-start.
// After pair-verify M4 the same socket expects HAP IP frames (2-byte LE
// length + ChaCha20-Poly1305) wrapping HTTP/1.1, not a new plaintext request.

import * as net from "node:net"
import * as crypto from "node:crypto"
import { Console, Effect } from "effect"
import type { EncryptedSession } from "@castcli/airplay"
import { EncryptedSession as Encrypted } from "@castcli/airplay"

export interface PairHttp {
  readonly get: (path: string) => Effect.Effect<{ status: number; body: Uint8Array }, unknown, Encrypted.Suite>
  readonly post: (
    path: string,
    body: Uint8Array,
    contentType?: string,
    extraHeaders?: Record<string, string>
  ) => Effect.Effect<{ status: number; body: Uint8Array }, unknown, Encrypted.Suite>
  readonly exchange: (
    method: string,
    path: string,
    body: Uint8Array,
    contentType: string,
    extraHeaders?: Record<string, string>,
    protocol?: string
  ) => Effect.Effect<{ status: number; body: Uint8Array }, unknown, Encrypted.Suite>
  readonly enableEncryption: (session: EncryptedSession) => void
  readonly setReadTimeout: (ms: number) => void
  readonly destroy: () => void
}

const tryParseHttp = (
  buf: Buffer
): { status: number; body: Uint8Array; consumed: number } | undefined => {
  const sep = buf.indexOf("\r\n\r\n")
  if (sep < 0) {
    return undefined
  }
  const header = buf.subarray(0, sep).toString("latin1")
  const statusLine = header.split("\r\n")[0] ?? ""
  const status = Number(statusLine.split(" ")[1] ?? "0")
  const cl = /content-length:\s*(\d+)/i.exec(header)
  const len = cl === null ? 0 : Number(cl[1])
  const start = sep + 4
  if (buf.length < start + len) {
    return undefined
  }
  return {
    status,
    body: new Uint8Array(buf.subarray(start, start + len)),
    consumed: start + len
  }
}

export const connect = (host: string, port: number): PairHttp => {
  const dacp = crypto.randomBytes(8).toString("hex").toUpperCase()
  const remote = String(crypto.randomInt(1, 0xffffffff))
  const baseHeaders: Record<string, string> = {
    "User-Agent": "AirPlay/320.20",
    Connection: "keep-alive",
    "X-Apple-HKP": "3",
    "X-Apple-Client-Name": "castcli",
    "DACP-ID": dacp,
    "Active-Remote": remote,
    "Client-Instance": dacp
  }

  let socket: net.Socket | undefined
  let session: EncryptedSession | undefined
  let incoming = Buffer.alloc(0)
  let waiters: Array<() => void> = []
  let readTimeoutMs = 8000

  const notify = () => {
    const current = waiters
    waiters = []
    for (const w of current) w()
  }

  let lastError: Error | undefined
  const attach = (s: net.Socket) => {
    s.on("data", (chunk: Buffer) => {
      incoming = Buffer.concat([incoming, chunk])
      notify()
    })
    s.on("error", (err: Error) => {
      lastError = err
      notify()
    })
    s.on("close", () => notify())
  }

  const ensureSocket = Effect.tryPromise({
    try: () =>
      new Promise<net.Socket>((resolve, reject) => {
        if (socket !== undefined && !socket.destroyed) {
          resolve(socket)
          return
        }
        const s = net.connect({ host, port }, () => {
          socket = s
          attach(s)
          resolve(s)
        })
        s.once("error", reject)
      }),
    catch: (cause) => cause as Error
  })

  const waitForMore = Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const s = socket
        if (s === undefined) {
          reject(new Error("no socket"))
          return
        }
        if (lastError !== undefined) {
          reject(lastError)
          return
        }
        const timer = setTimeout(() => {
          reject(new Error("AirPlay HTTP read timed out"))
        }, readTimeoutMs)
        waiters.push(() => {
          clearTimeout(timer)
          if (lastError !== undefined) reject(lastError)
          else resolve()
        })
      }),
    catch: (cause) => cause as Error
  })

  const encodeRequest = (
    method: string,
    path: string,
    body: Uint8Array,
    contentType: string,
    extraHeaders: Record<string, string>,
    protocol: string
  ): Uint8Array => {
    const headers = { ...baseHeaders, ...extraHeaders }
    const lines = [
      `${method} ${path} ${protocol}`,
      `Host: ${host}:${port}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      `Content-Type: ${contentType}`,
      `Content-Length: ${body.byteLength}`,
      "",
      ""
    ]
    const head = new TextEncoder().encode(lines.join("\r\n"))
    const msg = new Uint8Array(head.byteLength + body.byteLength)
    msg.set(head)
    msg.set(body, head.byteLength)
    return msg
  }

  const readPlainHttp = Effect.gen(function*() {
    while (true) {
      const parsed = tryParseHttp(incoming)
      if (parsed !== undefined) {
        incoming = incoming.subarray(parsed.consumed)
        return { status: parsed.status, body: parsed.body }
      }
      yield* waitForMore
    }
  })

  const readEncryptedHttp = (sess: EncryptedSession) =>
    Effect.gen(function*() {
      let decrypted = new Uint8Array()
      let cipher = new Uint8Array(incoming)
      incoming = Buffer.alloc(0)
      while (true) {
        const step = yield* Encrypted.decryptAvailable(sess, cipher)
        if (step.plaintext.byteLength > 0) {
          const next = new Uint8Array(decrypted.byteLength + step.plaintext.byteLength)
          next.set(decrypted)
          next.set(step.plaintext, decrypted.byteLength)
          decrypted = next
        }
        cipher = step.rest
        const parsed = tryParseHttp(Buffer.from(decrypted))
        if (parsed !== undefined) {
          incoming = Buffer.from(cipher)
          return { status: parsed.status, body: parsed.body }
        }
        yield* waitForMore
        const extra = new Uint8Array(cipher.byteLength + incoming.byteLength)
        extra.set(cipher)
        extra.set(incoming, cipher.byteLength)
        cipher = extra
        incoming = Buffer.alloc(0)
      }
    })

  const request = (
    method: string,
    path: string,
    body: Uint8Array,
    contentType: string,
    extraHeaders?: Record<string, string>,
    protocol?: string
  ) =>
    Effect.gen(function*() {
      yield* Console.log(`request begin ${method} ${path}`)
      const s = yield* ensureSocket
      const msg = encodeRequest(method, path, body, contentType, extraHeaders ?? {}, protocol ?? "HTTP/1.1")
      yield* Console.log(
        `${method} ${path} ${msg.byteLength} bytes plaintext, encrypted=${session !== undefined}`
      )
      const wire = session === undefined
        ? msg
        : yield* Encrypted.encryptMessage(session, msg)
      yield* Console.log(`writing ${wire.byteLength} bytes`)
      yield* Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            s.write(Buffer.from(wire), (err) => (err ? reject(err) : resolve()))
          }),
        catch: (cause) => cause as Error
      })
      return yield* (session === undefined ? readPlainHttp : readEncryptedHttp(session))
    })

  return {
    get: (path) => request("GET", path, new Uint8Array(), "application/octet-stream"),
    post: (path, body, contentType, extraHeaders) =>
      request("POST", path, body, contentType ?? "application/octet-stream", extraHeaders),
    exchange: (method, path, body, contentType, extraHeaders, protocol) =>
      request(method, path, body, contentType, extraHeaders, protocol),
    enableEncryption: (next) => {
      session = next
    },
    setReadTimeout: (ms) => {
      readTimeoutMs = ms
    },
    destroy: () => {
      socket?.destroy()
      socket = undefined
    }
  }
}
