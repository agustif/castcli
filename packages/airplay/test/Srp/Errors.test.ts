// The two failures, kept apart.
//
// The tags are asserted because callers dispatch on them: the pairing state
// machine answers a rejected proof with `PairingError.Authentication` and a
// retry, and an invalid public key by abandoning the exchange. A rename that
// merged them would compile.

import { assert, describe, it } from "@effect/vitest"
import { InvalidPublicKey, ProofRejected } from "../../src/Srp/Errors.ts"

describe("ProofRejected", () => {
  it("is tagged, and names which direction failed", () => {
    const rejected = new ProofRejected({ proof: "M1" })
    assert.strictEqual(rejected._tag, "SrpProofRejected")
    assert.include(rejected.message, "M1")
  })

  it("distinguishes the client's proof from the accessory's", () => {
    // Not cosmetic. An M1 rejection is a user mistyping a code; an M2
    // rejection is a device that cannot prove it holds the verifier, and
    // retrying that in a loop turns a detected impersonation into a
    // reconnection attempt.
    assert.notStrictEqual(
      new ProofRejected({ proof: "M1" }).message,
      new ProofRejected({ proof: "M2" }).message
    )
  })

  it("does not carry the proof it expected", () => {
    // An error that logs the expected value hands the answer to whoever reads
    // the log.
    assert.notInclude(Object.keys(new ProofRejected({ proof: "M1" })), "expected")
  })
})

describe("InvalidPublicKey", () => {
  it("is tagged separately from a rejected proof", () => {
    assert.strictEqual(new InvalidPublicKey({ side: "client" })._tag, "SrpInvalidPublicKey")
    assert.notStrictEqual(
      new InvalidPublicKey({ side: "client" })._tag,
      new ProofRejected({ proof: "M1" })._tag
    )
  })

  it("names whose key was rejected", () => {
    assert.include(new InvalidPublicKey({ side: "server" }).message, "server")
  })
})
