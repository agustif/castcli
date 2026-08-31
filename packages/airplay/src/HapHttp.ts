import { Effect } from "effect"
import * as crypto from "node:crypto"

// eslint-disable-next-line castcli/no-node-http -- Platform boundary: HAP requires keep-alive http.Agent
import * as http from "node:http"

/**
 * HAP pair-setup requires a single keep-alive HTTP/1.1 connection for the
 * entire M1→M2→M3→M4→M5→M6 sequence. Effect's FetchHttpClient opens a new
 * TCP socket per request, causing HTTP 470 empty responses from accessories.
 *
 * Proven 2026-08-31 on Apple TV: same-socket M2 200 409 bytes, M4 200 69 bytes,
 * M6 200 324 bytes.
 */

const DACP_ID = crypto.randomBytes(8).toString("hex")
const ACTIVE_REMOTE = crypto.randomInt(1, 0xFFFFFFFF).toString()

interface HapResponse {
  readonly status: number
  readonly body: Uint8Array
}

/**
 * Send a single HAP request and return response.
 *
 * Required headers:
 * - User-Agent: AirPlay/320.20
 * - Connection: keep-alive
 * - X-Apple-HKP: 3
 * - X-Apple-Client-Name: castcli
 * - DACP-ID: <random 16-hex>
 * - Active-Remote: <random uint32>
 * - Content-Type: application/octet-stream
 */
const hapRequest = (options: {
  readonly host: string
  readonly port: number
  readonly path: string
  readonly method: string
  readonly body?: Uint8Array
  readonly agent: http.Agent
}): Effect.Effect<HapResponse, Error> => {
  return Effect.promise(() =>
    // eslint-disable-next-line castcli/no-promise -- Platform boundary: wrapping Node http callback API in Effect
    new Promise<HapResponse>((resolve, reject) => {
      const req = http.request(
        {
          host: options.host,
          port: options.port,
          path: options.path,
          method: options.method,
          agent: options.agent,
          headers: {
            "User-Agent": "AirPlay/320.20",
            "Connection": "keep-alive",
            "X-Apple-HKP": "3",
            "X-Apple-Client-Name": "castcli",
            "DACP-ID": DACP_ID,
            "Active-Remote": ACTIVE_REMOTE,
            ...(options.body !== undefined
              ? {
                  "Content-Type": "application/octet-stream",
                  "Content-Length": options.body.length.toString()
                }
              : {})
          }
        },
        (res) => {
          const chunks: Array<Buffer> = []
          res.on("data", (chunk: Buffer) => chunks.push(chunk))
          res.on("end", () => {
            const body = new Uint8Array(Buffer.concat(chunks))
            const status = res.statusCode ?? 0
            resolve({ status, body })
          })
          res.on("error", reject)
        }
      )

      req.on("error", reject)
      void (options.body !== undefined ? req.write(Buffer.from(options.body)) : undefined)
      req.end()
    })
  )
}

interface HapConnection {
  readonly sendRequest: (path: string, method: string, body?: Uint8Array) => Effect.Effect<HapResponse, Error>
  readonly close: Effect.Effect<void>
}

/**
 * Create a keep-alive HAP connection for pair-setup sequence.
 *
 * Usage:
 * ```typescript
 * const conn = yield* createHapConnection({ host, port })
 * const info = yield* conn.sendRequest("/info", "GET")
 * const m2 = yield* conn.sendRequest("/pair-setup", "POST", m1Bytes)
 * const m4 = yield* conn.sendRequest("/pair-setup", "POST", m3Bytes)
 * const m6 = yield* conn.sendRequest("/pair-setup", "POST", m5Bytes)
 * yield* conn.close
 * ```
 */
export const createHapConnection = (options: {
  readonly host: string
  readonly port: number
}): Effect.Effect<HapConnection> =>
  Effect.sync(() => {
    const agent = new http.Agent({
      keepAlive: true,
      maxSockets: 1,
      keepAliveMsecs: 30000
    })

    return {
      sendRequest: (path: string, method: string, body?: Uint8Array) =>
        hapRequest({
          host: options.host,
          port: options.port,
          path,
          method,
          ...(body !== undefined ? { body } : {}),
          agent
        }),
      close: Effect.sync(() => {
        agent.destroy()
      })
    }
  })
