/**
 * The HAP cryptographic suite: the primitives Effect's own `Crypto` stops short
 * of, shaped the same way it is.
 *
 * `Crypto` is to `NodeCrypto` as this is to `NodeSuite`. Everything exported
 * here is platform-independent — an interface, a tag, a constructor, two nonce
 * constructions and an error. Nothing in this directory imports `node:` anything;
 * that lives one directory over, so a browser or Deno runtime replaces a layer
 * rather than a package.
 *
 * What is not exported here is private to the directory: `Nonce.fromSuffix`,
 * which pads eight bytes into twelve and trusts its caller, is the notable one.
 *
 * @since 0.1.0
 */
export type { CiphertextWithTag } from "./CiphertextWithTag.ts"
export { ForgedFrame } from "./Errors.ts"
export type { KeyPair } from "./KeyPair.ts"
export type { Primitives } from "./make.ts"
export { make } from "./make.ts"
export { Suite, SuiteTypeId } from "./Service.ts"
export { Sizes } from "./Sizes.ts"
export * as Nonce from "./Nonce/index.ts"
