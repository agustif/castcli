// The SRP group, read out of RFC 5054 rather than pasted.
//
// Apple's specification says only "as specified by the 3072-bit group of RFC
// 5054", so the RFC is the source and this is 768 hexadecimal digits that
// nobody should ever retype. A single wrong digit produces a modulus that is
// not prime, and the failure appears as a device rejecting the proof with no
// indication why.
//
// Read through a schema, not a regular expression. The heading and the sentence
// are both matched literally against the published text, so a group that has
// moved or been renumbered fails here with a message naming what it looked for
// — rather than yielding an empty string that becomes a plausible-looking
// `modulus: ""` in generated output nobody reads.

import { Effect, Schema } from "effect"
import { Rfc } from "@castcli/source"
import { generated, type Module } from "./Render.ts"

/** As printed, double space included: a normalised match would accept a heading
 * from a different revision. */
const SECTION = "4.  3072-bit Group"

const Modulus = Rfc.fromSection(SECTION, Rfc.HexDigits)

const Generator = Rfc.fromSection(
  SECTION,
  Rfc.labelled("The generator is:", Schema.FiniteFromString)
)

const PROSE = [
  "The SRP group AirPlay pairing uses, extracted from the published text of",
  "RFC 5054 rather than transcribed."
]

const rendered = (modulus: string, generator: number): string =>
  [
    "/**",
    " * The SRP group AirPlay pairing uses, from RFC 5054 section 4.",
    " *",
    // The bit length is computed from what was actually extracted, so a short
    // read says "2048 bits" in its own documentation rather than claiming 3072.
    ` * ${modulus.length * 4} bits, generator ${generator}. Extracted from the vendored RFC`,
    " * rather than transcribed: it is 768 hexadecimal digits, and one wrong",
    " * character gives a modulus that is not prime and a proof a device rejects",
    " * without saying why.",
    " */",
    "export const Group3072 = {",
    `  modulus: ${JSON.stringify(modulus)},`,
    `  generator: ${generator}`,
    "} as const",
    ""
  ].join("\n")

/**
 * `Generated/Group.ts`.
 *
 * Two decodes of the same document rather than one, because the modulus and the
 * generator are printed in different forms — columns of hex under a paragraph,
 * and a number in a sentence — and a single reader for both would have to guess
 * which it was looking at.
 */
export const Group: Module = {
  exports: ["Group3072"],
  render: (sources) =>
    Effect.all({
      modulus: Schema.decodeUnknownEffect(Modulus)(sources.rfc),
      generator: Schema.decodeUnknownEffect(Generator)(sources.rfc)
    }).pipe(
      Effect.map(({ generator, modulus }) =>
        [
          generated(["packages/airplay/vendor/rfc5054.txt"], PROSE),
          ``,
          rendered(modulus, generator)
        ].join("\n")
      )
    )
}
