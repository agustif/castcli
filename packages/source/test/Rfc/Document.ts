// The shape of a real RFC, in miniature.
//
// Shared by the tests below rather than repeated in each, because the point of
// it is a set of *awkward* features that have to stay together: headings
// indented, a subsection at the same indentation as its parent, a value stated
// in prose, and — in the section before — English words that happen to be valid
// hexadecimal. A copy that drifted would quietly stop testing one of those.
//
// It is not a substitute for the real thing. Every failure this codec has
// actually had came from the published layout differing from what a fixture
// assumed, so the tests here run against the vendored RFC 5054 as well.

export const document = [
  "   3.  Preliminaries",
  "",
  "       Nothing of interest. Note the added deface of bad data below,",
  "       which reads as hexadecimal and is not.",
  "",
  "   4.  A Group",
  "",
  "       Its hexadecimal value is:",
  "",
  "          FFFFFFFF FFFFFFFF C90FDAA2 2168C234",
  "          C4C6628B 80DC1CD1 29024E08 8A67CC74",
  "",
  "       The generator is: 5.",
  "",
  "   4.1.  A Subsection",
  "",
  "          AAAAAAAA",
  "",
  "   5.  After",
  "",
  "          BBBBBBBB"
].join("\n")

/** The vendored RFC the 3072-bit SRP group actually comes from. */
export const RFC_5054 = new URL("../../../airplay/vendor/rfc5054.txt", import.meta.url).pathname
