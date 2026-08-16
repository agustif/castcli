// Reading values out of a specification, the way `Schema.fromJsonString` reads
// values out of JSON.
//
// Specifications are a source format like any other. An RFC carries the
// authoritative value of a constant — a prime modulus, a generator, a table of
// codes — laid out for a 72-column terminal in a way no parser was meant to
// read. The usual answer is to copy the value into a source file by eye, which
// is exactly the operation this project avoids everywhere else.
//
// So: treat the RFC as an encoding.
//
//   Schema.fromJsonString(Schema.Number)   a number, encoded as JSON
//   Rfc.fromSection("4.  3072-bit Group", Rfc.HexDigits)   digits, encoded as an RFC
//
// The same three things follow as for JSON. Failure is a decoding failure with
// a path, not a silent empty string — a section that has moved says so, rather
// than yielding a modulus of `""`. Decoding composes with any other codec, so
// the digits become a `BigInt` or a `Uint8Array` by pipe rather than by hand.
// And it runs in both directions: `encode` lays the value back out in the
// RFC's own columns, which is what makes a round-trip test possible and is the
// only real check that the reader understood the layout rather than happening
// to produce the right length.
//
// The parts, in the order a reader meets them:
//
//   Text     the source format itself, named so failures can say so
//   Section  where a value is — the only address a specification guarantees
//   Hex      a large number, in the columns the RFC editor prints it in
//   Prose    a small number, in the sentence that states it
//
// `Lines` is shared plumbing and deliberately not exported: splitting a
// document into lines is not a concept this module offers anyone.

export { BigIntFromHexDigits, HexDigits } from "./Hex/index.ts"
export { labelled } from "./Prose/index.ts"
export { fromSection, section } from "./Section/index.ts"
export { Text } from "./Text.ts"
