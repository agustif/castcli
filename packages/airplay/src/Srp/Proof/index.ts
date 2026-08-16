/**
 * The two proofs, and the pieces they are built from.
 *
 * M1 and M2 are the part of AirPlay's SRP that no published specification
 * pins down, which is why they get a directory rather than a function: the
 * group digest inside M1 is where the padding rule inverts, and the comparison
 * used to check a proof is a security decision of its own.
 *
 * @since 0.1.0
 */
export { equal } from "./Equal.ts"
export { groupDigest } from "./GroupDigest.ts"
export { m1 } from "./M1.ts"
export { m2 } from "./M2.ts"
