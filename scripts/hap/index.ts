// The HomeKit pairing generator, one module per file it writes.
//
// Every export here is a `Module`: a list of the names its generated file
// offers, and a render that decodes the vendored source into that file's text.
// The split follows the output rather than the input, because the output is
// what gets imported and diffed — `Generated/Group.ts` has one reason to change
// and `Generated/Strings.ts` has another, and putting them in one 12KB file
// made every regeneration look like it touched everything.
//
//   Render      the shared emitters, and the shapes the entry point wires up
//   Vocabulary  the four enum families in HAPPairing.h
//   Group       the 3072-bit SRP group, out of RFC 5054
//   Vectors     Apple's SRP test vectors
//   Strings     the salts, info strings and nonce labels
//
// None of these touch the file system. They take the vendored text and return
// the file's contents, which is what lets the entry point be the only place
// that reads, writes or compares — and lets any of them be exercised against a
// fragment of C without a fixture on disk.

export { Group } from "./Group.ts"
export { barrel, generated, type Module, type Sources, table } from "./Render.ts"
export { Strings } from "./Strings.ts"
export { Vectors } from "./Vectors.ts"
export { Vocabulary } from "./Vocabulary.ts"
