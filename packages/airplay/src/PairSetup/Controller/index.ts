// Pair-setup, from the sender's side: six messages, and no socket.
//
// This is the exchange that turns a setup code on a television screen into a
// long-term key pair the two ends trust. Every step here is a pure function
// over bytes — it takes the accessory's last response and returns the next
// request together with what has to be carried forward — so the whole
// conversation can be driven from a test with nothing but arrays:
//
//   const request1 = yield* m1({ flags: [] })
//   const { request: request3, state } = yield* m3(m2Bytes, { pin })
//   const { request: request5, state: keyed } = yield* m5(m4Bytes, { state, identity })
//   const pairing = yield* finish(m6Bytes, keyed)
//
// Keeping the transport out is not tidiness. There is no device to test
// against here and there must not be, so agreement with the other half of the
// protocol — over bytes, in memory — is the only verification available, and a
// step that opened a connection could not participate in it. Whatever
// eventually carries these bytes over RTSP holds no protocol knowledge at all.
//
// What this exports is the four steps and the values that pass between them.
// The pieces they are built from — the response reader, the encrypted sub-TLV,
// the flags codec, the signed device info — are private to the directory: they
// are named where they are used and each is the subject of its own test, but
// nothing outside needs to assemble a pairing message by hand. The accessory
// half of this exchange needs mirrors of several of them; those belong to that
// directory until integration decides they are one thing.

export { finish } from "./Finish.ts"
export { type Identity, MAX_IDENTIFIER_BYTES } from "./Identity.ts"
export { m1, type Options } from "./M1.ts"
export { m3 } from "./M3.ts"
export { m5 } from "./M5.ts"
export type { Pairing, Peer } from "./Pairing.ts"
export type { Exchanged, Proved } from "./State.ts"
