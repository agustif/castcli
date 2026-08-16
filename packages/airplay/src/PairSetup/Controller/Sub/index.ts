// The message inside the message.
//
// M5 and M6 each carry a `kTLVType_EncryptedData` item whose value is a whole
// TLV8 payload, sealed with ChaCha20-Poly1305 under a key derived from the SRP
// shared secret. Sealing and opening are two files because each is a paragraph
// of reasoning of its own, and one directory because they are inverses: the
// empty associated data, the tag-at-the-end layout and the fact that the
// plaintext is an encoded payload rather than three values glued together are
// all decisions that have to be made identically in both, and a change to one
// that is not made in the other produces a frame that fails to authenticate
// with no indication of why.
//
// The nonce is not chosen here. It is a constant of the message — `PS-Msg05`
// outbound, `PS-Msg06` inbound — and it is passed in, so that a caller reading
// `M5.ts` can see which one that message uses.

export * from "./Open.ts"
export * from "./Seal.ts"
