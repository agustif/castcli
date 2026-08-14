// The one place `node:http` is allowed.
//
// `NodeHttpServer.layer` takes Node's `createServer` as its constructor, so the
// import is unavoidable — but it is confined here, behind `src/Platform/`,
// rather than leaking into application code.

import { NodeHttpServer } from "@effect/platform-node"
import { Effect } from "effect"
import { createServer } from "node:http"

/** Serve on every interface: only the *advertised* address has to be correct. */
export const layer = (port: number) => NodeHttpServer.layer(createServer, { port })

/**
 * A port the operating system says is free, obtained by binding to zero and
 * letting go.
 *
 * There is a race here in principle — something could take the port between
 * the release and the real bind — and it does not matter: the caller is already
 * handling a bind failure, which is what sent it here. Asking the OS beats
 * guessing, and the alternative (reading the address back out of a built
 * server layer) requires a service the router has already consumed.
 */
export const freePort = Effect.callback<number>((resume) => {
  const probe = createServer()
  probe.listen(0, () => {
    const address = probe.address()
    const port = address !== null && typeof address === "object" ? address.port : 0
    probe.close(() => resume(Effect.succeed(port)))
  })
})
