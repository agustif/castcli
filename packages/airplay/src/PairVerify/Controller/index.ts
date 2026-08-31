// Pair-verify, from the sender's side: two messages, and no socket.
//
// This is the exchange that proves both ends still hold the keys they agreed
// on during pair-setup. No PIN this time — just ephemeral Curve25519 keys and
// Ed25519 signatures over the shared secret. The whole conversation is two
// pure functions over bytes:
//
//   const { request: request1, ephemeralKeys } = yield* m1({ ephemeral: Option.none() })
//   const request3 = yield* m3(m2Bytes, { ephemeralKeys, pairing, controllerIdentity })
//
// Keeping the transport out means agreement with the other half of the
// protocol can be tested in memory, without a device. Whatever carries these
// bytes over HTTP holds no protocol knowledge at all.

export { m1 } from "./M1.ts"
export { m3 } from "./M3.ts"
