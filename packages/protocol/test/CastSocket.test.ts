// The socket, tested against the case that used to hang.
//
// `cast status` at a device that was off printed nothing, hung, and exited 0.
// Three causes stacked: the connection was deferred to the first write, the run
// fiber's failure was discarded, and there was no connect timeout at all. None
// of them are visible from the outside except as "no answer", so the test that
// matters is the crude one — point it at nothing and require a failure.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Brands } from "@castcli/domain"
import { connect } from "../src/CastSocket.ts"

/**
 * Port 1 on the loopback address: nothing listens there, and unlike a public
 * address it refuses immediately instead of relying on the timeout, which keeps
 * this test fast and independent of the network.
 */
const NOWHERE = Brands.Ipv4.make("127.0.0.1")
const CLOSED_PORT = Brands.Port.make(1)

describe("CastSocket", () => {
  it.effect("fails when nothing is listening, rather than hanging", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Effect.scoped(connect(NOWHERE, CLOSED_PORT)))

      // The specific requirement is that the failure arrives *at all*: the bug
      // was a connect that never settled, so the caller waited forever.
      assert.isTrue(exit._tag === "Failure")
    }))

  it.effect("reports an unreachable device as such, naming the address", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(Effect.scoped(connect(NOWHERE, CLOSED_PORT)))

      assert.strictEqual(failure._tag, "DeviceUnreachableError")
      assert.include(failure.message, "127.0.0.1:1")
      // The message has to say what to do next; a socket trace does not.
      assert.include(failure.message, "cast scan")
    }))
})
