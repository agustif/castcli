// Making the emulated device findable, the way a real one is.
//
// A Cast device announces itself over multicast DNS; a sender discovers it by
// asking `_googlecast._tcp.local` who is out there. Everything else here can be
// tested by handing the sender an address, but *discovery itself* cannot — and
// discovery is the path a person actually uses, since nobody types `--ip`
// unless something has gone wrong.
//
// So this is the encoding half of `platform/Mdns`, which already does the
// decoding. Writing the records the parser reads is a useful kind of symmetry:
// the two halves only agree if both are right.
//
// **Off unless asked for.** Advertising a Cast device on a real network is not
// a private act — phones and televisions on the same LAN will list it, and
// offer to play to something that is not a television. Tests opt in; nothing
// else does.

import { Effect, Queue, Ref, Scope, Stream } from "effect"
import { Brands } from "@castcli/domain"
import * as dgram from "node:dgram"

const MDNS_ADDRESS = "224.0.0.251"
const MDNS_PORT = 5353

const TYPE = {
  A: 1,
  PTR: 12,
  TXT: 16,
  SRV: 33
} as const

const CLASS_IN = 1
/** Cache-flush bit: this answer replaces whatever the asker had. */
const CACHE_FLUSH = 0x8000

export interface Advertisement {
  /** The service to answer for, e.g. `_googlecast._tcp.local`. */
  readonly service: string
  /** What a person sees in a device list. */
  readonly friendlyName: string
  readonly model: string
  /** Where the control channel is listening. */
  readonly port: Brands.Port
  /** The address to hand out. Loopback for a test; a LAN address to be real. */
  readonly address: string
}

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
 * One resource record.
 *
 * Names are written out in full rather than compressed. Compression is legal
 * and every parser must handle it, but writing it buys a few dozen bytes in a
 * packet that is already small, and a compression pointer computed wrongly is a
 * packet nobody can read.
 */
const record = (name: string, type: number, data: Buffer, ttl = 120): Buffer => {
  const header = Buffer.alloc(8)
  header.writeUInt16BE(type, 0)
  header.writeUInt16BE(CLASS_IN | CACHE_FLUSH, 2)
  header.writeUInt32BE(ttl, 4)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(data.length, 0)
  return Buffer.concat([encodeName(name), header, length, data])
}

const srvData = (port: number, target: string): Buffer => {
  const head = Buffer.alloc(6)
  head.writeUInt16BE(0, 0) // priority
  head.writeUInt16BE(0, 2) // weight
  head.writeUInt16BE(port, 4)
  return Buffer.concat([head, encodeName(target)])
}

/** Each entry is a length byte then `key=value`. */
const txtData = (pairs: ReadonlyArray<string>): Buffer =>
  Buffer.concat(
    pairs.map((pair) => {
      const bytes = Buffer.from(pair, "utf8")
      return Buffer.concat([Buffer.from([bytes.length]), bytes])
    })
  )

const addressData = (address: string): Buffer =>
  Buffer.from(address.split(".").map((octet) => Number(octet)))

/**
 * The full answer: what the device is called, where it is, and how to reach it.
 *
 * All four records travel together. A sender that receives the PTR without the
 * SRV knows a device exists and not where, which is worse than silence — it
 * shows up in a list and then fails to connect.
 */
const answer = (advertisement: Advertisement): Buffer => {
  const instance = `${advertisement.friendlyName}.${advertisement.service}`
  const host = `${advertisement.friendlyName.replaceAll(" ", "-")}.local`

  const records = [
    record(advertisement.service, TYPE.PTR, encodeName(instance)),
    record(instance, TYPE.SRV, srvData(advertisement.port, host)),
    record(
      instance,
      TYPE.TXT,
      txtData([
        `fn=${advertisement.friendlyName}`,
        `md=${advertisement.model}`,
        "id=emulated00000000000000000000000",
        // Version and status, which real devices always carry. `rs` empty means
        // nothing is playing.
        "ve=05",
        "rs="
      ])
    ),
    record(host, TYPE.A, addressData(advertisement.address))
  ]

  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0) // id: zero in mDNS
  header.writeUInt16BE(0x8400, 2) // response, authoritative
  header.writeUInt16BE(0, 4) // no questions echoed back
  header.writeUInt16BE(records.length, 6)
  return Buffer.concat([header, ...records])
}

// --------------------------------------------------------------- questions

/**
 * Read the questions out of a query.
 *
 * Only enough parsing to answer "is this for us": the name of each question,
 * skipping any compression pointer rather than following it. A querier that
 * compresses its own single question would be unusual, and getting it wrong
 * costs an unanswered query rather than a wrong answer.
 */
const readQuestionName = (
  packet: Buffer,
  offset: number,
  labels: ReadonlyArray<string>
): readonly [name: string, next: number] => {
  const length = packet[offset]

  return length === undefined || length === 0
    ? [labels.join("."), offset + 1]
    // A pointer means the rest of the name lives earlier in the packet. It is
    // not followed: a querier that compresses its own single question would be
    // unusual, and the cost of ignoring it is an unanswered query rather than a
    // wrong answer.
    : (length & 0xc0) === 0xc0
    ? [labels.join("."), offset + 2]
    : readQuestionName(packet, offset + 1 + length, [
      ...labels,
      packet.subarray(offset + 1, offset + 1 + length).toString("utf8")
    ])
}

const questionsIn = (packet: Buffer): ReadonlyArray<string> => {
  const count = packet.length >= 12 ? packet.readUInt16BE(4) : 0

  const take = (
    index: number,
    offset: number,
    found: ReadonlyArray<string>
  ): ReadonlyArray<string> => {
    const [name, next] = readQuestionName(packet, offset, [])
    return index >= count || offset >= packet.length
      ? found
      // Past the name comes the type and class, four bytes we do not need.
      : take(index + 1, next + 4, [...found, name])
  }

  return take(0, 12, [])
}

// --------------------------------------------------------------- listening

/**
 * Answer discovery queries for as long as the scope is open.
 *
 * The socket binds 5353 with `reuseAddr` so it can coexist with whatever the
 * operating system already runs there — on macOS that is mDNSResponder, which
 * would otherwise own the port outright.
 *
 * Replies go back to the querier directly rather than to the multicast group.
 * Senders set the QU bit precisely to ask for that, it keeps an emulated device
 * from announcing itself to a whole network, and it means the answer arrives
 * even where multicast delivery back to the sender is unreliable.
 */
export const serve = (
  advertisement: Advertisement
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*() {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true })
    const queries = yield* Queue.unbounded<{ packet: Buffer; from: dgram.RemoteInfo }>()
    const answered = yield* Ref.make(0)

    // The datagram callback cannot run an Effect, so it hands packets to a
    // queue — the same shape the discovery side uses.
    socket.on("message", (packet: Buffer, from: dgram.RemoteInfo) => {
      Queue.offerUnsafe(queries, { packet, from })
    })
    socket.on("error", () => undefined)

    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        socket.bind(MDNS_PORT, () => resume(Effect.void))
      }),
      () => Effect.sync(() => socket.close())
    )

    // Joining the group is what makes multicast queries arrive at all, but a
    // machine with no multicast-capable interface can refuse — and unicast
    // replies still reach a querier on the same host, which is the case the
    // tests care about. So this is reported and carried on from, not fatal.
    yield* Effect.try({
      try: () => socket.addMembership(MDNS_ADDRESS),
      catch: (cause) => cause
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug(`could not join the mDNS group; answering unicast only: ${cause}`)
      )
    )

    const reply = answer(advertisement)

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(queries), ({ from, packet }) =>
        Effect.when(
          Effect.andThen(
            Effect.sync(() => socket.send(reply, from.port, from.address, () => {})),
            Ref.update(answered, (count) => count + 1)
          ),
          Effect.succeed(
            questionsIn(packet).some((question) => question === advertisement.service)
          )
        ))
    )
  })

/**
 * Exported for the tests. The encoding here and the parsing in
 * `platform/Mdns` are two halves of one format, and they only agree if both
 * are right — which is worth asserting directly rather than inferring from a
 * device that happened to show up in a list.
 */
export const answerPacket = answer
export const questionsOf = questionsIn
