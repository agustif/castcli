// Keep-alive HAP HTTP: two requests on one TCP connection must both complete.
import * as Net from "node:net"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { NodeCrypto } from "@effect/platform-node"
import { NodeSuite } from "@castcli/airplay"
import * as HapHttpClient from "../src/hap-http-client.ts"

const Crypto = Layer.provide(NodeSuite, NodeCrypto.layer)

const respond = (socket: Net.Socket, body: string) => {
  const bytes = Buffer.from(body)
  socket.write(
    `HTTP/1.1 200 OK\r\nContent-Length: ${bytes.length}\r\nConnection: keep-alive\r\n\r\n${body}`
  )
}

const listen = (handle: (socket: Net.Socket) => void) =>
  Effect.callback<{ server: Net.Server; port: number }, Error>((resume) => {
    const server = Net.createServer(handle)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (addr === null || typeof addr === "string") {
        resume(Effect.fail(new Error("no listen port")))
        return
      }
      resume(Effect.succeed({ server, port: addr.port }))
    })
    server.on("error", (err) => resume(Effect.fail(err)))
  })

const closeServer = (server: Net.Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void))
  })

describe("HapHttpClient", () => {
  it.effect("completes a second GET on the same socket", () =>
    Effect.acquireUseRelease(
      listen((socket) => {
        let n = 0
        socket.on("data", () => {
          n += 1
          respond(socket, n === 1 ? "one" : "two")
        })
      }),
      ({ port }) =>
        Effect.gen(function* () {
          const client = yield* HapHttpClient.make("127.0.0.1", port, "AABBCCDD", "1")
          const first = yield* client.get("/one")
          const second = yield* client.get("/two")
          assert.strictEqual(first.status, 200)
          assert.strictEqual(new TextDecoder().decode(first.body), "one")
          assert.strictEqual(second.status, 200)
          assert.strictEqual(new TextDecoder().decode(second.body), "two")
        }).pipe(Effect.scoped),
      ({ server }) => closeServer(server)
    ).pipe(Effect.provide(Crypto)))
})
