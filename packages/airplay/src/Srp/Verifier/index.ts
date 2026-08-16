/**
 * What a password becomes: the private key x, and the verifier v derived from it.
 *
 * Two steps rather than one because they belong to different parties. The
 * client computes `x` on every exchange and never computes `v`; the accessory
 * computes `v` once at setup and can never recover `x`. Exporting only `v`
 * would leave the client reaching inside; exporting only `x` would leave every
 * caller to remember the padding rule for `v`.
 *
 * @since 0.1.0
 */
export { privateKey } from "./PrivateKey.ts"
export { verifier } from "./Verifier.ts"
