// A throwaway certificate for the emulated device.
//
// Real Cast devices present a self-signed chain and senders are expected not to
// verify it — our client passes `rejectUnauthorized: false` for exactly that
// reason — so any certificate at all is enough here. It exists only because TLS
// insists on one.
//
// Generated per run rather than committed: a private key in a repository is a
// bad habit even when the key protects nothing, and it would be the first thing
// a secret scanner complains about.

import { Clock, Context, Effect, Layer, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"


/**
 * Ask openssl for a self-signed pair.
 *
 * openssl rather than a library: it is present on macOS and on every CI image
 * this would run on, and Node can parse X.509 but not issue it.
 */
const generate: Effect.Effect<
  { readonly key: string; readonly cert: string },
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem | Path
> = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem
  const path = yield* Path

  // Cached rather than minted per run: generating an RSA key takes a
  // noticeable fraction of a second, and a throwaway certificate for a device
  // that nobody verifies has no reason to be different each time. A day of
  // validity means a stale one regenerates on its own.
  const directory = path.join("node_modules", ".cache", "castcli")
  const keyPath = path.join(directory, "emulator-key.pem")
  const certPath = path.join(directory, "emulator-cert.pem")
  yield* fs.makeDirectory(directory, { recursive: true })

  const now = yield* Clock.currentTimeMillis
  const fresh = yield* Effect.orElseSucceed(
    Effect.map(fs.stat(certPath), (info) =>
      Option.match(info.mtime, {
        onNone: () => false,
        onSome: (at) => now - at.getTime() < 12 * 60 * 60 * 1000
      })),
    () => false
  )

  yield* Effect.when(
    spawner.string(
    ChildProcess.make("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=cast-emulator"
    ])
    ),
    Effect.succeed(!fresh)
  )

  const key = yield* fs.readFileString(keyPath)
  const cert = yield* fs.readFileString(certPath)
  return { key, cert }
}).pipe(
  // The emulator is a test fixture; a machine without openssl should say so
  // plainly rather than surfacing a spawn failure from three layers down.
  Effect.catchCause((cause) =>
    Effect.die(new Error(`the emulated device needs openssl to make a certificate: ${cause}`))
  )
)

export class Certificate extends Context.Service<Certificate, {
  readonly key: string
  readonly cert: string
}>()("@castcli/emulator/Certificate") {
  /**
   * One certificate per layer, shared by every device built from it: generating
   * an RSA key takes a noticeable fraction of a second, and devices in a test
   * have no reason to have different ones.
   */
  static readonly layer = Layer.effect(Certificate, generate)
}
