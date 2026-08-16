// M1, against the only published M1 for this group and hash that exists.
//
// RFC 5054 stops at the session key; RFC 2945 defines M1 over SHA-1 and a
// different group. The vector in `packages/airplay/vendor/HAPCryptoTest.c` is
// the sole evidence for the combination AirPlay actually uses, which is why
// this file also runs the variant that was rejected — the value of a test
// vector is that it says no to something.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SrpVectors } from "../../../src/Generated/index.ts"
import * as Group from "../../../src/Srp/Group.ts"
import { hash, utf8 } from "../../../src/Srp/Hash.ts"
import { toBigInt } from "../../../src/Srp/Math/index.ts"
import { m1 } from "../../../src/Srp/Proof/M1.ts"

const group = Group.rfc5054

const exchange = {
  username: "alice",
  salt: SrpVectors.salt,
  clientPublic: toBigInt(SrpVectors.A),
  serverPublic: toBigInt(SrpVectors.B),
  sessionKey: SrpVectors.k
}

const xor = (left: Uint8Array, right: Uint8Array): Uint8Array =>
  Uint8Array.from(left, (octet, index) => octet ^ (right[index] ?? 0))

describe("m1", () => {
  it.effect("reproduces Apple's M1", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* m1(group, exchange), SrpVectors.m1)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("is not the variant with a padded generator", () =>
    Effect.gen(function*() {
      // The rejected variant, written out in full. `H(N) XOR H(PAD(g))` is
      // what RFC 5054's PAD() rule would suggest and what the multiplier four
      // functions away actually uses; here it produces a proof no accessory
      // accepts. Both were implemented and run before either was chosen.
      const padded = xor(
        yield* hash(Group.encode(group, group.modulus)),
        yield* hash(Group.encode(group, group.generator))
      )
      const wrong = yield* hash(
        padded,
        yield* hash(utf8(exchange.username)),
        exchange.salt,
        Group.encode(group, exchange.clientPublic),
        Group.encode(group, exchange.serverPublic),
        exchange.sessionKey
      )
      assert.notDeepEqual(
        wrong,
        SrpVectors.m1,
        "the padded variant also reproduces M1 — the vector cannot distinguish them"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("is not computed over the premaster secret in place of the session key", () =>
    Effect.gen(function*() {
      // The other reading the vector file invites, since S and K sit next to
      // each other and one of them is called `k`. Pinned as a rejection so the
      // mistake cannot be made silently.
      const wrong = yield* m1(group, { ...exchange, sessionKey: SrpVectors.S })
      assert.notDeepEqual(wrong, SrpVectors.m1)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("changes when any single field changes", () =>
    Effect.gen(function*() {
      // Each field is in there to bind the proof to something. A field that
      // could be altered without changing M1 would be a field an attacker
      // could alter in flight.
      const base = yield* m1(group, exchange)
      const altered = yield* Effect.all([
        m1(group, { ...exchange, username: "bob" }),
        m1(group, { ...exchange, salt: new Uint8Array(16) }),
        m1(group, { ...exchange, clientPublic: exchange.clientPublic - 1n }),
        m1(group, { ...exchange, serverPublic: exchange.serverPublic - 1n }),
        m1(group, { ...exchange, sessionKey: new Uint8Array(64) })
      ])
      assert.strictEqual(
        altered.filter((proof) => proof.every((octet, index) => octet === base[index])).length,
        0,
        "some field of M1 does not affect it"
      )
    }).pipe(Effect.provide(NodeServices.layer)))
})
