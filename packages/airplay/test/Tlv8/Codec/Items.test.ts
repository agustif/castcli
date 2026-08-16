// The payload codec, end to end.
//
// Values are random bytes from `Crypto.randomBytes` rather than a pattern.
// A pattern is worse than useless here: `new Uint8Array(512).fill(1)` survives
// a splitter that emits its fragments in the wrong order, one that drops a
// fragment and pads, and one that overlaps two slices, because every byte is
// interchangeable. Random values make the round trip an actual identity check.

import { assert, describe, it } from "@effect/vitest"
import { Crypto, Effect, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { TlvType } from "../../../src/Generated/index.ts"
import { Items } from "../../../src/Tlv8/Codec/Items.ts"
import type { Item } from "../../../src/Tlv8/Item.ts"

const encode = Schema.encodeEffect(Items)
const decode = Schema.decodeUnknownEffect(Items)

/** What the caller put in comes back out, byte for byte and in order. */
const roundTrip = (items: ReadonlyArray<Item>) =>
  Effect.gen(function*() {
    const wire = yield* encode(items)
    const back = yield* decode(wire)
    assert.deepStrictEqual(
      back.map((item) => ({ type: item.type, value: Array.from(item.value) })),
      items.map((item) => ({ type: item.type, value: Array.from(item.value) }))
    )
    return wire
  })

describe("Tlv8.Items", () => {
  it.effect("round-trips every type in the vocabulary, empty values included", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      // One item per generated type, the first of them empty, none long enough
      // to fragment — so this is the plain case, and it is here to catch a
      // codec that is wrong about the ordinary message before the boundary
      // tests below say anything about the interesting ones.
      const items = yield* Effect.forEach(
        Object.values(TlvType),
        (type, index) =>
          Effect.map(crypto.randomBytes(index * 3), (value): Item => ({ type, value }))
      )
      yield* roundTrip(items)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("round-trips a single item and an empty payload", () =>
    Effect.gen(function*() {
      yield* roundTrip([])
      yield* roundTrip([{ type: TlvType.State, value: new Uint8Array([1]) }])
      yield* roundTrip([{ type: TlvType.Separator, value: new Uint8Array(0) }])
    }))

  it.effect("writes a 512-byte value as exactly three fragments and reads it back whole", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const value = yield* crypto.randomBytes(512)
      const wire = yield* roundTrip([{ type: TlvType.PublicKey, value }])

      // Catches: a splitter that drops the final remainder (two fragments,
      // 510 bytes, and the round trip above already fails); one that writes
      // the remainder first; one whose length byte is the *total* length
      // truncated to a byte, which for 512 is 0 and reads as three empty
      // items. Three items of 2 header bytes each plus the value:
      assert.strictEqual(wire.length, 3 * 2 + 512)
      assert.deepStrictEqual(
        [wire[0], wire[1], wire[257], wire[258], wire[514], wire[515]],
        [TlvType.PublicKey, 255, TlvType.PublicKey, 255, TlvType.PublicKey, 2]
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("terminates a 255-byte value with an empty fragment of the same type", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const long = yield* crypto.randomBytes(255)
      const short = yield* crypto.randomBytes(4)

      // The load-bearing case. Two separate Identifier items, the first of
      // exactly 255 bytes — which is what a list response looks like when one
      // entry has a long identifier.
      const wire = yield* roundTrip([
        { type: TlvType.Identifier, value: long },
        { type: TlvType.Identifier, value: short }
      ])

      // Catches: a splitter that emits a fragment only when the value does not
      // fit. Under that mutation the wire is [01 FF …255…][01 04 …4…], the
      // reader is still mid-run at the second item, and the round trip above
      // returns one 259-byte identifier. The empty fragment between them is
      // the whole difference:
      assert.strictEqual(wire.length, (2 + 255) + (2 + 0) + (2 + 4))
      assert.deepStrictEqual([wire[257], wire[258]], [TlvType.Identifier, 0])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reads a 255-byte fragment and its empty terminator as one item", () =>
    Effect.gen(function*() {
      // The same case from the other side, against bytes this codec did not
      // write — a device's own output looks like this.
      const wire = Uint8Array.from([
        TlvType.Identifier,
        255,
        ...new Uint8Array(255).fill(7),
        TlvType.Identifier,
        0
      ])
      const items = yield* decode(wire)
      assert.deepStrictEqual(items.map((item) => item.value.length), [255])
    }))

  it.effect("keeps two non-adjacent items of the same type as two items", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto
      const first = yield* crypto.randomBytes(8)
      const second = yield* crypto.randomBytes(8)

      // Catches: rejoining by type instead of by adjacency. Under that
      // mutation this decodes to two items — one 16-byte identifier and the
      // permissions — and `ListPairings` reports one pairing whose identifier
      // is every identifier concatenated.
      const items = yield* decode(
        yield* encode([
          { type: TlvType.Identifier, value: first },
          { type: TlvType.Permissions, value: new Uint8Array([1]) },
          { type: TlvType.Identifier, value: second }
        ])
      )
      assert.strictEqual(items.length, 3)
      assert.deepStrictEqual(Array.from(items[2]?.value ?? new Uint8Array(0)), Array.from(second))
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fails on a payload that ends mid-item rather than returning the prefix", () =>
    Effect.gen(function*() {
      // Catches: a reader that clamps its slice to the end of the buffer, and
      // one that stops silently. Both would return the State item here and
      // drop the Proof, which is the item whose verification would have said
      // no.
      const truncated = Uint8Array.from([TlvType.State, 1, 3, TlvType.Proof, 64, 1, 2, 3])
      const exit = yield* Effect.exit(decode(truncated))
      assert.strictEqual(exit._tag, "Failure", "a truncated payload decoded")
    }))

  it.effect("fails to encode a type that does not fit in a byte", () =>
    Effect.gen(function*() {
      // The check on Item.type has to run in the encoding direction to be
      // worth anything — decoding cannot produce an out-of-range type, since
      // the bytes come out of a Uint8Array. This asserts that it does.
      const exit = yield* Effect.exit(encode([{ type: 256, value: new Uint8Array([1]) }]))
      assert.strictEqual(exit._tag, "Failure", "a type of 256 was encoded, as the byte 0")
    }))
})
