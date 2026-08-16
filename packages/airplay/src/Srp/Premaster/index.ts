/**
 * The premaster secret S, reached from either end.
 *
 * One number, two derivations that share no code — the accessory's from the
 * verifier it stored, the sender's from the PIN it was told. Keeping them in
 * one directory keeps the pair visible: a change to one that is not a change to
 * the other breaks the exchange, and the test that catches it is the one that
 * runs both.
 *
 * @since 0.1.0
 */
export { fromPassword } from "./FromPassword.ts"
export { fromVerifier } from "./FromVerifier.ts"
