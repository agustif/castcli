// Reading values out of C source, the way `Rfc` reads them out of a
// specification.
//
// The sibling of `Rfc`, one source format over. Where an RFC states a constant
// in prose and prints it in columns, an implementation states it as a
// declaration — and vendored implementation source is the *better* authority of
// the two, because it is what a shipping device was compiled from. Apple's
// HomeKit ADK carries the pairing vocabulary that AirPlay 2 authentication is
// built on, and it is newer than the specification PDF they used to publish.
//
// So: treat the C file as an encoding.
//
//   Rfc.fromSection("4.  3072-bit Group", Rfc.HexDigits)   digits, encoded as an RFC
//   Cee.enumeration("kHAPPairingTLVType_")                 a vocabulary, encoded as C
//
// The motivation is a bug that already happened. The generator that reads this
// header used to find enum values with the pattern `[^,;)]+`, which stops at a
// comma — and the last member of an enum has no trailing comma. So
// `kHAPPairingMethod_PairResume` was dropped. Nothing failed. A constant was
// simply absent, and stayed absent, because absence has no symptom until a
// device sends the value and gets an error nobody can look up.
//
// Every reader here is a `Schema.ConstraintCodec<_, string>`: it decodes *from*
// the text of a C file, an identifier it cannot find is a decoding failure
// whose message names what was looked for, and nothing ever returns an empty
// array or an empty string to mean "not there".
//
// The parts:
//
//   Source      the format itself, named so failures can say so
//   Comment     blanking commentary, which every reader below depends on
//   Identifier  matching a C name literally, at its boundaries
//   Enum        a family of constants and the expressions that give them values
//   Literal     a named string or byte array
//   Survey      every literal in a file, for proving a table complete
//
// What this is not is a C parser. The preprocessor does not run: `#include` is
// not followed, macros are not expanded, and both arms of an `#if` are visible.
// Each reader says in its own documentation what it does about that, and the
// answer is never to guess.

export { enumeration, Member, Members } from "./Enum/index.ts"
export { byteArray, stringLiteral } from "./Literal/index.ts"
export { Text } from "./Source.ts"
export { stringLiterals } from "./Survey.ts"
