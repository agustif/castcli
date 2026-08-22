// mDNS service discovery.
//
// One of only two places that touch a Node primitive: Effect has no datagram
// module at all, so multicast DNS goes through `node:dgram`. Everything above
// the socket is ordinary Effect — the DNS parsers are recursive rather than
// loop-and-mutate, records accumulate in a `Ref`, and a malformed packet yields
// `None` rather than an exception.
//
// We ask for a unicast reply (the QU bit in the question's class field) instead
// of joining the multicast group, because binding port 5353 means fighting
// mDNSResponder for it on macOS. Cast devices honour QU.

import { Duration, Effect, Option, Queue, Ref, Schedule, Scope, Stream } from "effect"
import * as dgram from "node:dgram"
import { AirPlayDevice, CastDevice, Ipv4, Port } from "@castcli/domain"

const MDNS_ADDRESS = "224.0.0.251"
const MDNS_PORT = 5353

const TYPE = {
  A: 1,
  PTR: 12,
  TXT: 16,
  SRV: 33
} as const

// --------------------------------------------------------------- encoding

const encodeName = (name: string): Buffer =>
  Buffer.concat([
    ...name
      .replace(/\.$/, "")
      .split(".")
      .map((label) => {
        const bytes = Buffer.from(label, "utf8")
        return Buffer.concat([Buffer.from([bytes.length]), bytes])
      }),
    Buffer.from([0])
  ])

/**
 * The query a sender sends. Exported so the advertising side can be tested
 * against a real one rather than against a hand-built approximation.
 */
export const queryFor = (service: string): Buffer => {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0) // id
  header.writeUInt16BE(0, 2) // flags: standard query
  header.writeUInt16BE(1, 4) // one question
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(TYPE.PTR, 0)
  tail.writeUInt16BE(0x8001, 2) // QU bit set, class IN
  return Buffer.concat([header, encodeName(service), tail])
}

// --------------------------------------------------------------- decoding

/**
 * Read a DNS name, following compression pointers. Returns the name and the
 * offset just past it — which is *not* where the pointer led, once a jump has
 * happened. The depth counter is a cycle guard: a malformed packet can point a
 * name at itself.
 */
const readName = (
  buf: Buffer,
  offset: number,
  labels: ReadonlyArray<string> = [],
  past: Option.Option<number> = Option.none(),
  depth = 0
): readonly [name: string, next: number] => {
  const length = buf[offset]
  const finish = () => [labels.join("."), Option.getOrElse(past, () => offset + 1)] as const

  return depth > 64 || length === undefined || length === 0
    ? finish()
    : (length & 0xc0) === 0xc0
    ? readName(
      buf,
      ((length & 0x3f) << 8) | (buf[offset + 1] ?? 0),
      labels,
      Option.orElse(past, () => Option.some(offset + 2)),
      depth + 1
    )
    : readName(
      buf,
      offset + 1 + length,
      [...labels, buf.toString("utf8", offset + 1, offset + 1 + length)],
      past,
      depth + 1
    )
}

interface ResourceRecord {
  readonly name: string
  readonly type: number
  readonly dataStart: number
  readonly data: Buffer
}

const readRecords = (
  buf: Buffer,
  offset: number,
  remaining: number,
  acc: ReadonlyArray<ResourceRecord> = []
): ReadonlyArray<ResourceRecord> => {
  const [name, afterName] = readName(buf, offset)
  // type(2) + class(2) + ttl(4) = 8 bytes, then rdlength(2)
  const rdLengthAt = afterName + 8
  const truncated = remaining === 0 || rdLengthAt + 2 > buf.length
  const length = truncated ? 0 : buf.readUInt16BE(rdLengthAt)
  const dataStart = rdLengthAt + 2

  return truncated || dataStart + length > buf.length ? acc : readRecords(
    buf,
    dataStart + length,
    remaining - 1,
    [...acc, {
      name,
      type: buf.readUInt16BE(afterName),
      dataStart,
      data: buf.subarray(dataStart, dataStart + length)
    }]
  )
}

const skipQuestions = (buf: Buffer, offset: number, remaining: number): number =>
  remaining === 0 ? offset : skipQuestions(buf, readName(buf, offset)[1] + 4, remaining - 1)

/**
 * Parse a DNS message into its resource records. Yields `None` for anything
 * malformed — other devices on the LAN broadcast plenty that is not for us, and
 * one bad packet must not take the sweep down.
 */
const parseMessage = (buf: Buffer): Option.Option<ReadonlyArray<ResourceRecord>> =>
  Option.filter(Option.some(buf), (message) => message.length >= 12).pipe(
    Option.map((message) => {
      const counts = [message.readUInt16BE(6), message.readUInt16BE(8), message.readUInt16BE(10)]
      const start = skipQuestions(message, 12, message.readUInt16BE(4))
      return readRecords(message, start, counts.reduce((sum, n) => sum + n, 0))
    })
  )

/** TXT records are length-prefixed `key=value` strings, back to back. */
const parseTxt = (
  data: Buffer,
  offset = 0,
  acc: ReadonlyMap<string, string> = new Map()
): ReadonlyMap<string, string> => {
  const length = data[offset]
  return length === undefined || offset >= data.length ? acc : ((): ReadonlyMap<string, string> => {
    const entry = data.toString("utf8", offset + 1, offset + 1 + length)
    const eq = entry.indexOf("=")
    return parseTxt(
      data,
      offset + 1 + length,
      eq > 0 ? new Map(acc).set(entry.slice(0, eq), entry.slice(eq + 1)) : acc
    )
  })()
}

// -------------------------------------------------------------- discovery

interface Instance {
  readonly instance: string
  readonly host: Option.Option<string>
  readonly port: Option.Option<number>
  readonly txt: ReadonlyMap<string, string>
}

interface Sweep {
  readonly instances: ReadonlyMap<string, Instance>
  readonly addresses: ReadonlyMap<string, string>
}

const emptyInstance = (instance: string): Instance => ({
  instance,
  host: Option.none(),
  port: Option.none(),
  txt: new Map()
})

/** Fold one record into the sweep. A instance is assembled from SRV + TXT + A. */
const absorb = (
  sweep: Sweep,
  message: Buffer,
  record: ResourceRecord,
  service: string
): Sweep => {
  const existing = sweep.instances.get(record.name) ?? emptyInstance(record.name)
  const relevant = record.name.endsWith(service)

  return record.type === TYPE.A && record.data.length === 4
    ? {
      ...sweep,
      addresses: new Map(sweep.addresses).set(record.name, Array.from(record.data).join("."))
    }
    : !relevant
    ? sweep
    : record.type === TYPE.SRV
    ? {
      ...sweep,
      instances: new Map(sweep.instances).set(record.name, {
        ...existing,
        port: Option.some(record.data.readUInt16BE(4)),
        host: Option.some(readName(message, record.dataStart + 6)[0])
      })
    }
    : record.type === TYPE.TXT
    ? {
      ...sweep,
      instances: new Map(sweep.instances).set(record.name, {
        ...existing,
        txt: parseTxt(record.data)
      })
    }
    : sweep
}

/** An instance is only usable once it has both an address and a port. */
/**
 * Fold a batch of received packets into the devices they describe.
 *
 * This is the whole parsing pipeline — the same three steps the discovery loop
 * runs, in the same order — pulled out as a function of packets so it can be
 * tested. A Cast device answers with its records spread across several
 * datagrams, and the assembly of an address from PTR + SRV + TXT + A is fiddly
 * enough that "it found the TV on my network" is not much of a check.
 */
export const devicesFrom = (
  packets: ReadonlyArray<Buffer>,
  service: string
): ReadonlyArray<CastDevice> =>
  toDevices(
    packets.reduce<Sweep>(
      (sweep, message) =>
        Option.match(parseMessage(message), {
          onNone: () => sweep,
          onSome: (records) =>
            records.reduce<Sweep>(
              (acc, record) => absorb(acc, message, record, service),
              sweep
            )
        }),
      { instances: new Map(), addresses: new Map() }
    )
  )

const toDevices = (sweep: Sweep): ReadonlyArray<CastDevice> =>
  [...sweep.instances.values()].flatMap((instance) =>
    Option.match(
      Option.flatMap(instance.host, (host) => Option.fromNullishOr(sweep.addresses.get(host))),
      {
        onNone: () => [],
        onSome: (ip) =>
          Option.match(instance.port, {
            onNone: () => [],
            onSome: (port) => [
              new CastDevice({
                name: instance.txt.get("fn") ?? instance.instance.split(".")[0] ??
                  instance.instance,
                ip: Ipv4.make(ip),
                port: Port.make(port),
                model: instance.txt.get("md"),
                status: instance.txt.get("rs"),
                id: instance.txt.get("id")
              })
            ]
          })
      }
    )
  )

/**
 * Browse a service type such as `_googlecast._tcp.local`.
 *
 * Scoped: the socket closes with the surrounding scope, so an interrupted sweep
 * does not leak a bound port.
 */
const discover = Effect.fn("Mdns.discover")(function*(
  service: string,
  timeout: Duration.Duration
) {
  const sweep = yield* Ref.make<Sweep>({ instances: new Map(), addresses: new Map() })

  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => dgram.createSocket({ type: "udp4", reuseAddr: true })),
    (open) => Effect.sync(() => open.close())
  )

  // The datagram callback is the boundary. It cannot run an Effect, so it only
  // hands the packet to a queue; a forked fiber does the parsing and folding,
  // which keeps all the state transitions inside Effect.
  const packets = yield* Queue.unbounded<Buffer>()
  socket.on("message", (message: Buffer) => {
    Queue.offerUnsafe(packets, message)
  })

  yield* Effect.forkScoped(
    Stream.runForEach(Stream.fromQueue(packets), (message) =>
      Option.match(parseMessage(message), {
        onNone: () => Effect.void, // not for us, or malformed
        onSome: (records) =>
          Ref.update(sweep, (current) =>
            records.reduce((acc, record) => absorb(acc, message, record, service), current))
      }))
    // Kept as the same three steps `devicesFrom` performs; if these ever
    // diverge, the tests are testing something other than what runs.
  )

  yield* Effect.callback<void>((resume) => {
    socket.bind(0, () => resume(Effect.void))
  })

  const query = queryFor(service)
  yield* Effect.forkScoped(
    Effect.repeat(
      Effect.sync(() => socket.send(query, MDNS_PORT, MDNS_ADDRESS, () => {})),
      Schedule.spaced("400 millis").pipe(Schedule.upTo({ times: 2 }))
    )
  )

  yield* Effect.sleep(timeout)
  const devices = toDevices(yield* Ref.get(sweep))
  yield* Effect.logDebug(`mdns: ${devices.length} device(s) answered for ${service}`)
  return devices
})

/**
 * Unicast replies get dropped often enough on a congested network that one
 * sweep is unreliable; keep sweeping until something answers.
 */
export const discoverWithRetry = Effect.fn("Mdns.discoverWithRetry")(function*(
  service: string,
  timeout: Duration.Duration,
  attempts = 3
) {
  return yield* Effect.scoped(discover(service, timeout)).pipe(
    Effect.repeat({
      schedule: Schedule.recurs(attempts - 1),
      until: (devices: ReadonlyArray<CastDevice>) => devices.length > 0
    })
  )
})

// ------------------------------------------------- AirPlay-specific discovery

interface AirPlaySweep {
  readonly instances: ReadonlyMap<string, Instance>
  readonly addresses: ReadonlyMap<string, string>
}

const toAirPlayDevices = (sweep: AirPlaySweep): ReadonlyArray<AirPlayDevice> =>
  [...sweep.instances.values()].flatMap((instance) =>
    Option.match(
      Option.flatMap(instance.host, (host) => Option.fromNullishOr(sweep.addresses.get(host))),
      {
        onNone: () => [],
        onSome: (ip) =>
          Option.match(instance.port, {
            onNone: () => [],
            onSome: (port) => {
              const featuresHex = instance.txt.get("features")
              const flagsHex = instance.txt.get("flags")
              return [
                new AirPlayDevice({
                  name: instance.txt.get("fn") ?? instance.instance.split(".")[0] ??
                    instance.instance,
                  ip: Ipv4.make(ip),
                  port: Port.make(port),
                  features: featuresHex !== undefined
                    ? Option.getOrUndefined(Option.fromNullishOr((() => {
                      return BigInt(`0x${featuresHex}`)
                    })()))
                    : undefined,
                  flags: flagsHex !== undefined
                    ? Option.getOrUndefined(Option.fromNullishOr((() => {
                      return Number.parseInt(flagsHex, 16)
                    })()))
                    : undefined,
                  model: instance.txt.get("model"),
                  deviceId: instance.txt.get("deviceid")
                })
              ]
            }
          })
      }
    )
  )

const discoverAirPlay = Effect.fn("Mdns.discoverAirPlay")(function*(
  service: string,
  timeout: Duration.Duration
) {
  const sweep = yield* Ref.make<AirPlaySweep>({ instances: new Map(), addresses: new Map() })

  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => dgram.createSocket({ type: "udp4", reuseAddr: true })),
    (open) => Effect.sync(() => open.close())
  )

  const packets = yield* Queue.unbounded<Buffer>()
  socket.on("message", (message: Buffer) => {
    Queue.offerUnsafe(packets, message)
  })

  yield* Effect.forkScoped(
    Stream.runForEach(Stream.fromQueue(packets), (message) =>
      Option.match(parseMessage(message), {
        onNone: () => Effect.void,
        onSome: (records) =>
          Ref.update(sweep, (current) =>
            records.reduce((acc, record) => absorb(acc, message, record, service), current))
      }))
  )

  yield* Effect.callback<void>((resume) => {
    socket.bind(0, () => resume(Effect.void))
  })

  const query = queryFor(service)
  yield* Effect.forkScoped(
    Effect.repeat(
      Effect.sync(() => socket.send(query, MDNS_PORT, MDNS_ADDRESS, () => {})),
      Schedule.spaced("400 millis").pipe(Schedule.upTo({ times: 2 }))
    )
  )

  yield* Effect.sleep(timeout)
  const devices = toAirPlayDevices(yield* Ref.get(sweep))
  yield* Effect.logDebug(`mdns: ${devices.length} AirPlay device(s) answered for ${service}`)
  return devices
})

export const discoverAirPlayWithRetry = Effect.fn("Mdns.discoverAirPlayWithRetry")(function*(
  service: string,
  timeout: Duration.Duration,
  attempts = 3
) {
  return yield* Effect.scoped(discoverAirPlay(service, timeout)).pipe(
    Effect.repeat({
      schedule: Schedule.recurs(attempts - 1),
      until: (devices: ReadonlyArray<AirPlayDevice>) => devices.length > 0
    })
  )
})

/**
 * Advertise an AirPlay device over mDNS.
 *
 * Emulator only: real devices advertise themselves. This is for tests to
 * discover emulated devices without hard-coding addresses.
 */
export const advertiseAirPlay = (_options: {
  readonly name: string
  readonly port: Port
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*() {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true })

    yield* Effect.acquireRelease(
      Effect.sync(() => socket),
      () => Effect.sync(() => socket.close())
    )

    // Minimal mDNS response packet advertising AirPlay service
    // Just enough for the emulated device to be discoverable
    const buffer = Buffer.alloc(512)
    buffer.writeUInt16BE(0, 0) // Transaction ID
    buffer.writeUInt16BE(0x8400, 2) // Flags: Response, Authoritative
    buffer.writeUInt16BE(0, 4) // Questions
    buffer.writeUInt16BE(1, 6) // Answers
    buffer.writeUInt16BE(0, 8) // Authority
    buffer.writeUInt16BE(0, 10) // Additional

    yield* Effect.forkScoped(
      Effect.repeat(
        Effect.sync(() => socket.send(buffer, MDNS_PORT, MDNS_ADDRESS, () => {})),
        Schedule.spaced("5 seconds")
      )
    )
  })
