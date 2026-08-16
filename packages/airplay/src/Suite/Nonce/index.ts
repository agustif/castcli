/**
 * The two nonce constructions HAP uses, and nothing else.
 *
 * This is the module's contract. `fromSuffix` — which pads eight bytes into
 * twelve and trusts its argument — is not here on purpose: it is how the two
 * constructions below are built, not a third construction. If a caller could
 * reach it, "assemble a nonce by hand" would be back on the table, and the whole
 * point of an opaque `Nonce` is that it is not.
 *
 * @since 0.1.0
 */
export type { Nonce } from "./Nonce.ts"
export { label } from "./Label.ts"
export { counter } from "./Counter.ts"
