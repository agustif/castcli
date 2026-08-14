// mDNS response parsing.
//
// A Cast device answers a query with PTR, SRV, TXT and A records, often spread
// across several datagrams and using DNS name compression, so assembling one
// usable address out of them is fiddly. "It found the TV on my network" is not
// much of a check — these build the packets a device actually sends and take
// them apart again.

import { assert, describe, it } from "@effect/vitest"
import { devicesFrom } from "../src/Mdns.ts"

const SERVICE = "_googlecast._tcp.local"

/** A DNS name as wire labels: length byte, bytes, ... terminated by zero. */
const name = (value: string): Buffer =>
  Buffer.concat([
    ...value.split(".").map((label) =>
      Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "utf8")])
    ),
    Buffer.from([0])
  ])

const record = (owner: string, type: number, data: Buffer): Buffer =>
  Buffer.concat([
    name(owner),
    Buffer.from([0, type, 0, 1]), // type, class IN
    Buffer.from([0, 0, 0, 120]), // ttl
    Buffer.from([(data.length >> 8) & 0xff, data.length & 0xff]),
    data
  ])

/** A response packet: header saying "answer", then the records. */
const response = (records: ReadonlyArray<Buffer>): Buffer =>
  Buffer.concat([
    Buffer.from([0, 0, 0x84, 0]), // id 0, flags: response + authoritative
    Buffer.from([0, 0]), // no questions
    Buffer.from([0, records.length]), // answers
    Buffer.from([0, 0, 0, 0]), // no authority or additional
    ...records
  ])

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const

const srv = (host: string, port: number): Buffer =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 0]), // priority, weight
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    name(host)
  ])

const txt = (pairs: ReadonlyArray<string>): Buffer =>
  Buffer.concat(
    pairs.map((pair) => Buffer.concat([Buffer.from([pair.length]), Buffer.from(pair, "utf8")]))
  )

const address = (ip: string): Buffer => Buffer.from(ip.split(".").map(Number))

/** Everything a Xiaomi TV sends, in one packet. */
const fullAnswer = (options: {
  readonly instance?: string
  readonly host?: string
  readonly ip?: string
  readonly port?: number
} = {}) => {
  const instance = options.instance ?? `Televisor-Xiaomi.${SERVICE}`
  const host = options.host ?? "xiaomi-tv.local"
  return response([
    record(SERVICE, TYPE.PTR, name(instance)),
    record(instance, TYPE.SRV, srv(host, options.port ?? 8009)),
    record(instance, TYPE.TXT, txt(["fn=Televisor Xiaomi 100", "md=MiTV-MOEU0", "rs="])),
    record(host, TYPE.A, address(options.ip ?? "192.168.1.24"))
  ])
}

describe("devicesFrom", () => {
  it("assembles one device from the records a Cast device sends", () => {
    const devices = devicesFrom([fullAnswer()], SERVICE)

    assert.strictEqual(devices.length, 1)
    assert.strictEqual(devices[0]?.ip, "192.168.1.24")
    assert.strictEqual(devices[0]?.port, 8009)
    // `fn` is the friendly name, which is what `--device` matches against.
    assert.strictEqual(devices[0]?.name, "Televisor Xiaomi 100")
    assert.strictEqual(devices[0]?.model, "MiTV-MOEU0")
  })

  it("joins records that arrived in separate packets", () => {
    // Devices routinely split their answer, and an address that arrives after
    // the service record still has to be attached to it.
    const instance = `Televisor-Xiaomi.${SERVICE}`
    const host = "xiaomi-tv.local"
    const devices = devicesFrom(
      [
        response([record(instance, TYPE.SRV, srv(host, 8009))]),
        response([record(instance, TYPE.TXT, txt(["fn=Televisor Xiaomi 100"]))]),
        response([record(host, TYPE.A, address("192.168.1.24"))])
      ],
      SERVICE
    )

    assert.strictEqual(devices.length, 1)
    assert.strictEqual(devices[0]?.ip, "192.168.1.24")
  })

  it("ignores a service that is not the one asked for", () => {
    const devices = devicesFrom(
      [fullAnswer({ instance: "Printer._ipp._tcp.local", host: "printer.local" })],
      SERVICE
    )

    assert.deepStrictEqual(devices, [])
  })

  it("yields nothing for an instance with no address", () => {
    // A device named but not located cannot be cast to, and half a device is
    // worse than none: it would be offered and then fail to connect.
    const instance = `Televisor-Xiaomi.${SERVICE}`
    const devices = devicesFrom(
      [response([record(instance, TYPE.SRV, srv("missing.local", 8009))])],
      SERVICE
    )

    assert.deepStrictEqual(devices, [])
  })

  it("survives a malformed packet without losing the good ones", () => {
    const devices = devicesFrom(
      [Buffer.from([0, 0, 0x84]), Buffer.alloc(0), fullAnswer()],
      SERVICE
    )

    assert.strictEqual(devices.length, 1)
  })

  it("reports several devices separately", () => {
    const devices = devicesFrom(
      [
        fullAnswer(),
        fullAnswer({
          instance: `Kitchen-Speaker.${SERVICE}`,
          host: "kitchen.local",
          ip: "192.168.1.31"
        })
      ],
      SERVICE
    )

    assert.deepStrictEqual(
      devices.map((device) => device.ip).toSorted(),
      ["192.168.1.24", "192.168.1.31"]
    )
  })
})
