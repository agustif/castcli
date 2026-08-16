/**
 * The conversion between HAP's raw 32-byte keys and Node's `KeyObject`.
 *
 * It has its own directory rather than living inside `Ed25519.ts` because both
 * curves need exactly the same three operations against envelopes that differ by
 * one byte. Written twice, the two copies would be a diff no reviewer reads
 * carefully; written once with the differing byte named, the thing most likely
 * to be wrong in this package is four short files a reviewer can check against
 * RFC 8410 without running anything.
 *
 * @since 0.1.0
 */
export type { Curve } from "./Curve.ts"
export { Ed25519, X25519 } from "./Curve.ts"
export { exportPublic } from "./exportPublic.ts"
export { importPrivate } from "./importPrivate.ts"
export { importPublic } from "./importPublic.ts"
