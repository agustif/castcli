// Named constants whose value is data rather than a number.
//
// A salt, an info string, a nonce, a test vector: the things a key-derivation
// step is parameterised by, which have to match the other end byte for byte and
// which are exactly the wrong length to retype accurately.
//
//   Declaration  how such a thing is spelled in C, shared by both readers
//   Escape       C's string escapes, both directions
//   Text         the value of a string constant
//   Bytes        the contents of a byte array
//
// Both readers refuse to answer when a file gives one name several values,
// rather than returning the first. `salt` occurs five times in Apple's pairing
// implementation with five different contents, and a reader that picked one
// would be right four-fifths of the time and silent about the rest.

export { byteArray } from "./Bytes.ts"
export { stringLiteral } from "./Text.ts"
