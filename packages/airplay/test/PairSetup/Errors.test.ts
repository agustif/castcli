// The error family, and the one decision inside it that is not bookkeeping.
//
// Almost everything here is a message, and a message is worth testing only
// because these are what a user and a maintainer see when pairing fails: an
// error that says "PairSetupMalformedItem" and nothing else sends someone to
// read the source. What is not bookkeeping is `fromWire`, which decides whether
// a byte from the accessory is "your setup code was wrong" — the one failure a
// user can act on — or one of the six that mean something else entirely.

import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { PairingError, TlvType } from "../../src/Generated/index.ts"
import {
  AccessoryRefused,
  fromWire,
  IdentifierTooLong,
  MalformedItem,
  MissingItem,
  SignatureRejected,
  UnexpectedState
} from "../../src/PairSetup/Errors.ts"

describe("fromWire", () => {
  it("makes a wrong setup code its own error, not one refusal among seven", () => {
    // The distinction the whole module exists for. A caller has to be able to
    // branch on this without inspecting a numeric field, because the response
    // to it — tell the user, let them type it again — is unlike the response to
    // every other code.
    const error = fromWire({ step: "M4", code: PairingError.Authentication })
    assert.strictEqual(error._tag, "PairSetupWrongSetupCode")
    assert.strictEqual(error.message, "pair-setup M4: the accessory rejected the setup code")
  })

  it("names the code it declined with, for the six that are not the setup code", () => {
    const error = fromWire({ step: "M2", code: PairingError.Busy })
    assert.strictEqual(error._tag, "PairSetupAccessoryRefused")
    assert.strictEqual(error.message, "pair-setup M2: the accessory declined with Busy (7)")
  })

  it("still reports a code HAP does not define as a refusal", () => {
    // The case a stricter decoder would get wrong. An accessory speaking a
    // later specification declines with a byte this vocabulary has never seen;
    // treating that as a malformed message would leave a caller retrying
    // against a device that has stopped answering.
    const error = fromWire({ step: "M6", code: 99 })
    assert.strictEqual(error._tag, "PairSetupAccessoryRefused")
    assert.strictEqual(
      error.message,
      "pair-setup M6: the accessory declined with an unnamed value (99)"
    )
  })
})

describe("messages", () => {
  it("names a missing item by its type rather than its number", () => {
    assert.strictEqual(
      new MissingItem({ step: "M2", within: "message", type: TlvType.Salt }).message,
      "pair-setup M2: the message has no Salt item"
    )
  })

  it("distinguishes the message from the sub-TLV sealed inside it", () => {
    // Which of the two an item was missing from is the difference between a
    // problem visible in a packet capture and one visible only to something
    // holding the session key.
    assert.strictEqual(
      new MissingItem({ step: "M6", within: "sub-TLV", type: TlvType.Signature }).message,
      "pair-setup M6: the sub-TLV has no Signature item"
    )
  })

  it("gives both lengths for an item of the wrong size", () => {
    assert.strictEqual(
      new MalformedItem({
        step: "M6",
        within: "sub-TLV",
        type: TlvType.PublicKey,
        constraint: "exactly",
        expected: 32,
        received: 5
      }).message,
      "pair-setup M6: the sub-TLV's PublicKey item is 5 bytes; expected exactly 32"
    )
  })

  it("says when a State item was absent rather than merely different", () => {
    assert.strictEqual(
      new UnexpectedState({ step: "M4", expected: 4, received: Option.none() }).message,
      "pair-setup M4: expected State 4, got no readable kTLVType_State item"
    )
    assert.strictEqual(
      new UnexpectedState({ step: "M4", expected: 4, received: Option.some(2) }).message,
      "pair-setup M4: expected State 4, got 2"
    )
  })

  it("says whose signature failed", () => {
    // `peer` rather than a single message, because the accessory half of this
    // exchange raises the same error about the controller and a log with both
    // in it has to be readable.
    assert.strictEqual(
      new SignatureRejected({ step: "M6", peer: "accessory" }).message,
      "pair-setup M6: the accessory's signature over its own device info did not verify"
    )
  })

  it("gives the limit an identifier overran", () => {
    assert.strictEqual(
      new IdentifierTooLong({ bytes: 40, limit: 36 }).message,
      "pair-setup: a pairing identifier is at most 36 bytes; this one is 40"
    )
  })
})

describe("tags", () => {
  it("are distinct, so a caller can match on them", () => {
    // Data.TaggedError gives each of these a `_tag`; the point of the assertion
    // is that no two of them share one, since a caller branching on the tag
    // would otherwise silently handle two failures as one.
    const tags = [
      new AccessoryRefused({ step: "M2", code: 1 })._tag,
      fromWire({ step: "M2", code: PairingError.Authentication })._tag,
      new UnexpectedState({ step: "M2", expected: 2, received: Option.none() })._tag,
      new MissingItem({ step: "M2", within: "message", type: TlvType.Salt })._tag,
      new MalformedItem({
        step: "M2",
        within: "message",
        type: TlvType.Salt,
        constraint: "exactly",
        expected: 16,
        received: 0
      })._tag,
      new IdentifierTooLong({ bytes: 40, limit: 36 })._tag,
      new SignatureRejected({ step: "M6", peer: "accessory" })._tag
    ]
    assert.strictEqual(new Set(tags).size, tags.length)
  })
})
