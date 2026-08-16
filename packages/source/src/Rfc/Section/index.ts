// Sections: the unit an RFC addresses its own contents by.
//
// A heading is the only stable address in a published specification — line
// numbers move with every revision and page numbers move with the formatter —
// so a section is how this module says *where* a value is, before saying what
// kind of value it is.
//
// `Heading` holds the rule for what a heading is and which headings nest inside
// which; `Body` uses that rule to cut a section out; `Codec` is the pair of
// those as a Schema transformation, so an absent section is a decoding failure
// with the heading in its message rather than an empty string.

export { fromSection, section } from "./Codec.ts"
