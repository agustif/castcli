// Reading what the accessory answered.
//
// `read` is what the steps use and is the whole of the contract: it decodes the
// payload, turns a `kTLVType_Error` into a tagged error and checks the State
// byte, in that order, and the order is the reason it exists rather than each
// step doing the three itself.
//
// The three checks are exported beside it because each is separately wrong-able
// and separately testable — a refusal that is read as a missing item, a State
// that is not checked at all — and because the accessory half of this exchange
// needs the same three in the same order on the messages it receives.
//
// What is not here is `Query.find` and friends: pulling a value out of a
// decoded message is `Tlv8`'s job, and `Require.ts` only adds the part that is
// specific to pairing, which is what to do when the value is absent or the
// wrong size.

export * from "./Expect.ts"
export * from "./Read.ts"
export * from "./Refusal.ts"
export * from "./Require.ts"
