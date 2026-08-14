// The one place `node:http` is allowed.
//
// `NodeHttpServer.layer` takes Node's `createServer` as its constructor, so the
// import is unavoidable — but it is confined here, behind `src/Platform/`,
// rather than leaking into application code.

import { NodeHttpServer } from "@effect/platform-node"
import { createServer } from "node:http"

/** Serve on every interface: only the *advertised* address has to be correct. */
export const layer = (port: number) => NodeHttpServer.layer(createServer, { port })
