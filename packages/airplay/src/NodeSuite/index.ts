/**
 * The Node implementation of the HAP cryptographic suite.
 *
 * `NodeCrypto` exports one `layer` and nothing else, and so does this: the
 * primitives inside are an implementation detail of that layer, and a caller who
 * imported `Aead.seal` directly would have bypassed the length checks in
 * `Suite.make` and the ability to swap the implementation out. Everything a
 * program needs — the interface, the tag, the nonce constructions, the error —
 * comes from `Suite`, and this supplies the one thing that has to know about
 * `node:crypto`.
 *
 * @since 0.1.0
 */
export { layer } from "./layer.ts"
