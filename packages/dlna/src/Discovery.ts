// SSDP discovery over UDP.
//
// The socket lives beside the protocol it speaks, as the Cast TLS transport
// does: Effect has no datagram module, so `node:dgram` is unavoidable, and the
// packages that have to touch it are the ones that own a wire format. Keeping
// it here rather than in `platform` avoids the inversion of a generic bridge
// package depending on a specific protocol for its message shapes.
//
// SSDP differs from mDNS in one way that matters. A device may wait a random
// interval of up to `MX` seconds before answering, precisely so that a hundred
// televisions do not reply in the same millisecond — so the socket has to stay
// open for at least that long, and a sweep that closes early quietly finds only
// the fastest devices on the network.

import { Duration, Effect, Option, Queue, Ref, Schedule, Scope, Stream } from "effect"
import * as Ssdp from "./Ssdp.ts"
import * as dgram from "node:dgram"

const MULTICAST_ADDRESS = "239.255.255.250"
const MULTICAST_PORT = 1900

/**
 * Search for devices of a type, gathering answers until the wait is over.
 *
 * The query is sent more than once. UDP discovery is lossy by nature and a
 * single lost datagram means a device that simply does not appear, which reads
 * as "my television is broken" rather than "a packet was dropped".
 */
export const search = (
  target: string,
  wait: Duration.Duration
): Effect.Effect<ReadonlyArray<Ssdp.Found>, never, Scope.Scope> =>
  Effect.gen(function*() {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true })
    const packets = yield* Queue.unbounded<string>()
    const found = yield* Ref.make<ReadonlyArray<Ssdp.Found>>([])

    // The datagram callback cannot run an Effect, so it hands the text to a
    // queue and a forked fiber does the parsing — the same boundary `Mdns`
    // draws, and the reason neither reaches for the runtime from library code.
    socket.on("message", (packet: Buffer) => {
      Queue.offerUnsafe(packets, packet.toString("utf8"))
    })
    socket.on("error", () => undefined)

    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        socket.bind(0, () => resume(Effect.void))
      }),
      () => Effect.sync(() => socket.close())
    )

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(packets), (packet) =>
        Option.match(Ssdp.parseResponse(packet), {
          onNone: () => Effect.void,
          onSome: (device) =>
            // Devices announce themselves repeatedly by design, so the unique
            // service name is the key that keeps one television from appearing
            // four times.
            Ref.update(found, (all) =>
              all.some((existing) => existing.usn === device.usn) ? all : [...all, device])
        }))
    )

    const query = Buffer.from(Ssdp.searchFor(target, Math.ceil(Duration.toSeconds(wait))), "utf8")

    yield* Effect.forkScoped(
      Effect.repeat(
        Effect.sync(() => socket.send(query, MULTICAST_PORT, MULTICAST_ADDRESS, () => {})),
        Schedule.spaced(Duration.millis(400)).pipe(Schedule.upTo({ times: 2 }))
      )
    )

    yield* Effect.sleep(wait)
    const devices = yield* Ref.get(found)
    yield* Effect.logDebug(`ssdp: ${devices.length} device(s) answered for ${target}`)
    return devices
  })
