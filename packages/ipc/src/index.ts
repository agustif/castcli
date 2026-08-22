// IPC for control commands: cast play → cast seek/pause/status.
//
// Architecture: unix domain socket with schema-validated messages. Control
// commands attach to the running play session through a socket, not by polling
// a file.

import { Effect, Schema } from "effect"
import * as net from "node:net"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Seconds } from "@castcli/domain"

/** Control requests sent from `cast seek` / `cast pause` to the play session. */
export const ControlRequest = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Seek"),
    toSeconds: Seconds,
    id: Schema.Number
  }),
  Schema.Struct({
    _tag: Schema.Literal("Pause")
  }),
  Schema.Struct({
    _tag: Schema.Literal("Resume")
  }),
  Schema.Struct({
    _tag: Schema.Literal("Status")
  })
)

export type ControlRequest = typeof ControlRequest.Type

export const ControlResponse = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("Ok")
  }),
  Schema.Struct({
    _tag: Schema.Literal("StatusResponse"),
    position: Seconds,
    playing: Schema.Boolean
  }),
  Schema.Struct({
    _tag: Schema.Literal("Error"),
    message: Schema.String
  })
)

export type ControlResponse = typeof ControlResponse.Type

const decodeRequest = Schema.decodeUnknown(ControlRequest)
const encodeResponse = Schema.encode(ControlResponse)

/** Unix socket path for this session. */
const socketPath = (file: string): string =>
  path.join(os.tmpdir(), `castcli-${Buffer.from(file).toString("base64url").slice(0, 32)}.sock`)

export interface ControlServer {
  readonly onRequest: (
    handler: (request: ControlRequest) => Effect.Effect<ControlResponse>
  ) => Effect.Effect<void, never, never>
}

/** Server: listen on unix socket and handle control requests. */
export const makeServer = (file: string): Effect.Effect<ControlServer, never, Effect.Scope.Scope> =>
  Effect.gen(function*() {
    const sock = socketPath(file)
    
    // Clean up stale socket
    yield* Effect.sync(() => {
      try { fs.unlinkSync(sock) } catch {}
    })

    const server = net.createServer()

    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.listen(sock, () => resume(Effect.void))
      }),
      () => Effect.sync(() => {
        server.close()
        try { fs.unlinkSync(sock) } catch {}
      })
    )

    return {
      onRequest: (handler) =>
        Effect.gen(function*() {
          server.on("connection", (socket) => {
            let buffer = ""
            socket.on("data", (chunk) => {
              buffer += chunk.toString()
              const newline = buffer.indexOf("\n")
              if (newline !== -1) {
                const line = buffer.slice(0, newline)
                buffer = buffer.slice(newline + 1)
                
                Effect.runPromise(
                  Effect.gen(function*() {
                    const json = JSON.parse(line)
                    const request = yield* decodeRequest(json)
                    const response = yield* handler(request)
                    const encoded = yield* encodeResponse(response)
                    socket.write(JSON.stringify(encoded) + "\n")
                    socket.end()
                  }).pipe(
                    Effect.catchAll(() =>
                      Effect.sync(() => {
                        socket.write(JSON.stringify({ _tag: "Error", message: "Invalid request" }) + "\n")
                        socket.end()
                      })
                    )
                  )
                )
              }
            })
          })
        })
    }
  })

/** Client: send control request to running session. */
export const sendRequest = (file: string, request: ControlRequest): Effect.Effect<ControlResponse> =>
  Effect.gen(function*() {
    const sock = socketPath(file)
    const encoded = yield* Schema.encode(ControlRequest)(request)
    
    return yield* Effect.async<ControlResponse>((resume) => {
      const socket = net.connect(sock)
      let buffer = ""
      
      socket.on("connect", () => {
        socket.write(JSON.stringify(encoded) + "\n")
      })
      
      socket.on("data", (chunk) => {
        buffer += chunk.toString()
        const newline = buffer.indexOf("\n")
        if (newline !== -1) {
          const line = buffer.slice(0, newline)
          try {
            const json = JSON.parse(line)
            Effect.runCallback(
              Effect.flatMap(
                Schema.decodeUnknown(ControlResponse)(json),
                (response) => Effect.succeed(resume(Effect.succeed(response)))
              ).pipe(
                Effect.catchAll(() => Effect.succeed(
                  resume(Effect.fail({ _tag: "IPCError" as const, message: "Invalid response" }))
                ))
              )
            )
          } catch {
            resume(Effect.fail({ _tag: "IPCError" as const, message: "Invalid JSON" }))
          }
        }
      })
      
      socket.on("error", (err) => {
        resume(Effect.fail({ _tag: "IPCError" as const, message: err.message }))
      })
    })
  })
