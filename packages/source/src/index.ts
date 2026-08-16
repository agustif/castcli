// First sources, as codecs.
//
// The values this project puts on the wire come from specifications and from
// vendored implementation source. Both are read here rather than transcribed,
// so that a source which changes shows up as a decoding failure or a diff
// instead of as a constant that was right once.
//
//   Rfc  the published plain text of a specification
//   Cee  the C headers and implementation files a device was compiled from
//
// The two are deliberately the same shape. A reader is a Schema that decodes
// *from* the text of the source, so composition, failure and encoding all work
// the way they do for `Schema.fromJsonString` — and in particular a value that
// has moved produces a message naming what was looked for, rather than an empty
// string that becomes a plausible-looking constant in generated output.
export * as Cee from "./Cee/index.ts"
export * as Rfc from "./Rfc/index.ts"
