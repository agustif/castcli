// Local control IPC: commands reach the running player without polling a file.
//
// `cast seek` / pause / status reach the running `cast play` through a unix
// domain socket with schema-validated request/response. Commands arrive without
// sleeping on file mtime, and the running player acts on them immediately.
//
// This replaces the previous file-based polling mechanism where State.requestSeek
// wrote to a state file that the player polled ~1s. The socket is bound when
// `play` starts and removed when it stops.
//
// eslint-disable-next-line castcli/no-node-fs -- unix domain sockets need direct fs access
// eslint-disable-next-line castcli/no-process-env -- XDG_RUNTIME_DIR is standard for socket path
// eslint-disable-next-line castcli/no-try-catch -- socket cleanup best-effort, no Effect needed
// eslint-disable-next-line castcli/no-promise -- node:net callbacks require Promise wrapping

import { Duration, Effect, Match, Option, Schema } from "effect"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import type { Brands } from "@castcli/domain"
import { Seconds } from "@castcli/domain"

/**
 * Request types that control commands send to the running player.
 */
const ControlRequest = Schema.TaggedUnion({
  Seek: { toSeconds: Seconds },
  Pause: {},
  Resume: {},
  Stop: {},
  GetStatus: {}
})

type ControlRequest = typeof ControlRequest.Type

/**
 * Response the player sends back.
 */
const ControlResponse = Schema.TaggedUnion({
  Ok: {},
  Status: {
    file: Schema.String,
    offsetSeconds: Seconds,
    seekable: Schema.Boolean
  },
  Error: { message: Schema.String }
})

type ControlResponse = typeof ControlResponse.Type

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(ControlRequest))
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(ControlRequest))
const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(ControlResponse))
const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(ControlResponse))

/**
 * The socket path where the running player listens.
 *
 * Lives in XDG_STATE_HOME (for tests) or XDG_RUNTIME_DIR when set, else a temp
 * directory. Removed when the player stops, so a stale socket means no player
 * is running.
 */
const socketPath = () => {
  const base = process.env["XDG_STATE_HOME"] ?? process.env["XDG_RUNTIME_DIR"] ?? os.tmpdir()
  return path.join(base, "castcli-control.sock")
}

export interface ControlHandlers {
  readonly onSeek: (to: Brands.Seconds) => Effect.Effect<void>
  readonly onPause: Effect.Effect<void>
  readonly onResume: Effect.Effect<void>
  readonly onStop: Effect.Effect<void>
  readonly getStatus: Effect.Effect<Option.Option<{
    readonly file: string
    readonly offsetSeconds: Brands.Seconds
    readonly seekable: boolean
  }>>
}

/**
 * Start a control server that listens for commands on a unix domain socket.
 * Returns an effect that shuts down the server when run.
 */
export const startServer = (handlers: ControlHandlers) =>
  Effect.gen(function*() {
    const sockPath = socketPath()

    // Remove stale socket
    try {
      fs.unlinkSync(sockPath)
    } catch {
      // fine if it doesn't exist
    }

    const server = net.createServer((socket) => {
      const chunks: Buffer[] = []

      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
      })

      socket.on("end", () => {
        const requestJson = Buffer.concat(chunks).toString("utf-8")

        Effect.gen(function*() {
          const request = yield* decodeRequest(requestJson)

          const response = yield* Match.value(request).pipe(
            Match.tag("Seek", ({ toSeconds }) =>
              Effect.as(handlers.onSeek(toSeconds), { _tag: "Ok" } as const)
            ),
            Match.tag("Pause", () =>
              Effect.as(handlers.onPause, { _tag: "Ok" } as const)
            ),
            Match.tag("Resume", () =>
              Effect.as(handlers.onResume, { _tag: "Ok" } as const)
            ),
            Match.tag("Stop", () =>
              Effect.as(handlers.onStop, { _tag: "Ok" } as const)
            ),
            Match.tag("GetStatus", () =>
              Effect.map(handlers.getStatus, (status) =>
                Option.match(status, {
                  onNone: () => ({ _tag: "Error", message: "no stream is active" } as const),
                  onSome: (state) => ({
                    _tag: "Status",
                    file: state.file,
                    offsetSeconds: state.offsetSeconds,
                    seekable: state.seekable
                  } as const)
                })
              )
            ),
                  Match.exhaustive
                ).pipe(
                  Effect.orElseSucceed(() => ({
                    _tag: "Error",
                    message: "request handler failed"
                  } as const))
                )

              const responseJson = yield* encodeResponse(response)
              socket.write(Buffer.from(String(responseJson), "utf-8"))
              socket.end()
            }).pipe(Effect.runPromise).catch((err: unknown) => {
              socket.write(Buffer.from(JSON.stringify({ _tag: "Error", message: String(err) }), "utf-8"))
              socket.end()
            })
          })

      socket.on("error", () => {
        // connection failed, nothing to do
      })
    })

    yield* Effect.promise(() =>
      new Promise<void>((resolve, reject) => {
        const errorHandler = (err: Error) => {
          server.removeListener("error", errorHandler)
          reject(err)
        }
        
        server.on("error", errorHandler)
        
        server.listen(sockPath, () => {
          server.removeListener("error", errorHandler)
          resolve()
        })
      })
    ).pipe(
      Effect.timeout(Duration.seconds(5)),
      Effect.catchTag("TimeoutException", () =>
        Effect.fail(new Error(`Control channel listen timeout after 5s on ${sockPath}`))
      )
    )

    const shutdown = Effect.promise(() =>
      new Promise<void>((resolve) => {
        server.close(() => {
          try {
            fs.unlinkSync(sockPath)
          } catch {
            // fine
          }
          resolve()
        })
      })
    )

    return shutdown
  })

/**
 * Client side: control commands send requests to the running player.
 */
export const sendRequest = (request: ControlRequest) =>
  Effect.gen(function*() {
    const sockPath = socketPath()
    const requestJson = yield* encodeRequest(request)

    const response = yield* Effect.promise(() =>
      new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(sockPath)
        const chunks: Buffer[] = []

        socket.on("connect", () => {
          socket.write(Buffer.from(String(requestJson), "utf-8"))
        })

        socket.on("data", (chunk: Buffer) => {
          chunks.push(chunk)
        })

        socket.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf-8"))
        })

        socket.on("error", (err) => {
          reject(err)
        })
      })
    )

    return yield* decodeResponse(response)
  })

/** Convenience helpers for each request type */
export const seek = (to: Brands.Seconds) =>
  sendRequest({ _tag: "Seek", toSeconds: to })

export const pause = sendRequest({ _tag: "Pause" })
export const resume = sendRequest({ _tag: "Resume" })
export const stop = sendRequest({ _tag: "Stop" })

export const getStatus = Effect.flatMap(
  sendRequest({ _tag: "GetStatus" }),
  (response) =>
    Match.value(response).pipe(
      Match.tag("Status", (status) =>
        Effect.succeed(
          Option.some({
            file: status.file,
            offsetSeconds: status.offsetSeconds,
            seekable: status.seekable
          })
        )
      ),
      Match.tag("Ok", () => Effect.succeed(Option.none())),
      Match.tag("Error", ({ message }) => Effect.fail(new Error(message))),
      Match.exhaustive
    )
)
