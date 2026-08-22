// Pair-verify controller: the three-message exchange that proves both ends.
//
// Like pair-setup, these are pure functions over bytes with no socket. The
// transport (RTSP POST /pair-verify) is separate. Each step takes the
// accessory's response and returns the next request plus what must be carried
// forward.
//
// Usage:
//   const ephemeral = yield* keyPair(Option.none())
//   const request1 = yield* m1(ephemeral.publicKey)
//   // ... POST request1, receive m2Bytes ...
//   const { request: request3, proved } = yield* m3(m2Bytes, ephemeral, ...)
//   // ... POST request3, receive m4Bytes ...
//   const sessionKey = yield* finish(m4Bytes, sharedSecret)

export { finish } from "./Finish.ts"
export { m1 } from "./M1.ts"
export { m3, type Proved } from "./M3.ts"
