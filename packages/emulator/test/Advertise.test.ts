// Advertising and discovery are two halves of one format.
//
// `emulator/Advertise` writes the records that `platform/Mdns` reads. Testing
// them against each other is the only way to know both are right: a device that
// shows up in a list proves the pair agree, but not that either matches what a
// real Chromecast sends — and a bug in both directions cancels out.

import { assert, describe, it } from "@effect/vitest"
import { Brands } from "@castcli/domain"
import { Mdns } from "@castcli/platform"
import { answerPacket, questionsOf } from "../src/Advertise.ts"

const SERVICE = "_googlecast._tcp.local"

const ADVERTISEMENT = {
  service: SERVICE,
  friendlyName: "Emulated Living Room",
  model: "FakeCast",
  port: Brands.Port.make(8009),
  address: "127.0.0.1"
}

describe("advertisement", () => {
  it("is readable by the discovery it exists to be found by", () => {
    const [device] = Mdns.devicesFrom([answerPacket(ADVERTISEMENT)], SERVICE)

    assert.strictEqual(device?.name, "Emulated Living Room")
    assert.strictEqual(device?.ip, "127.0.0.1")
    assert.strictEqual(device?.port, 8009)
    assert.strictEqual(device?.model, "FakeCast")
  })

  it("carries the port the control channel is actually on", () => {
    // The SRV port is how a sender knows where to connect, and an emulated
    // device is on whatever port the operating system gave it — so a hard-coded
    // 8009 here would work everywhere except in the tests that matter.
    const [device] = Mdns.devicesFrom(
      [answerPacket({ ...ADVERTISEMENT, port: Brands.Port.make(51234) })],
      SERVICE
    )

    assert.strictEqual(device?.port, 51234)
  })

  it("answers nothing for a service it is not offering", () => {
    assert.deepStrictEqual(Mdns.devicesFrom([answerPacket(ADVERTISEMENT)], "_airplay._tcp.local"), [])
  })

  it("keeps a name with spaces intact", () => {
    // The friendly name becomes both a DNS label and the text a person reads;
    // the two are not the same string, and conflating them renamed the device
    // to its hostname.
    const [device] = Mdns.devicesFrom(
      [answerPacket({ ...ADVERTISEMENT, friendlyName: "Kitchen Display 2" })],
      SERVICE
    )

    assert.strictEqual(device?.name, "Kitchen Display 2")
  })
})

describe("questions", () => {
  it("reads what a sender is asking for", () => {
    // Built by the discovery side, read by the advertising side — the reverse
    // direction of the test above.
    const query = Mdns.queryFor(SERVICE)

    assert.deepStrictEqual(questionsOf(query), [SERVICE])
  })

  it("finds nothing in a packet with no questions", () => {
    assert.deepStrictEqual(questionsOf(answerPacket(ADVERTISEMENT)), [])
  })

  it("survives a truncated packet", () => {
    // Anything may arrive on a multicast port. Answering it is optional;
    // crashing is not.
    assert.deepStrictEqual(questionsOf(Buffer.from([0, 0, 0])), [])
  })
})
