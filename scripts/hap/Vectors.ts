// Apple's SRP test vectors, from the ADK's own crypto tests.
//
// Extracted rather than retyped: they are hundreds of hex bytes each, and a
// single transposed digit would produce a test that fails for a reason nobody
// can find.
//
// The values go through `Cee.byteArray`, which is the part that matters. The
// pattern this replaced took the braced initialiser as `[^}]*` and then pulled
// `0x..` pairs out of it, so an element written any other way — a decimal, a
// shifted expression, a character literal — was skipped rather than reported.
// A vector that is short by one byte is not a failed extraction; it is a
// different number, and the test built on it fails against the device with no
// indication that the fixture is the thing that is wrong. `Cee.byteArray`
// evaluates every element and stops on one it cannot.

import { Effect, Schema } from "effect"
import { Cee } from "@castcli/source"
import { generated, type Module } from "./Render.ts"

/**
 * The names, scanned; the values, decoded.
 *
 * This is the one regular expression left in the generator, and it is here
 * because `Cee` reads a constant a caller can name and has no survey of the
 * arrays a file declares — the counterpart of `Cee.stringLiterals`, which does
 * exactly that for strings. Listing the ten names by hand instead would be
 * worse in the way this whole approach exists to avoid: a vector added upstream
 * would not appear, and nothing would say so.
 *
 * The `\{` is load-bearing. `srp_user` and `srp_pass` share the prefix and are
 * string literals — `"alice"` and `"password123"`, the RFC 5054 Appendix B
 * inputs — so a scan that stopped at the `=` would hand `Cee.byteArray` a name
 * it would then refuse, correctly, as being declared as a string.
 */
const DECLARED = /static const uint8_t (srp_\w+)\[\]\s*=\s*\{/g

const PROSE = [
  "Apple's SRP test vectors. Their published vectors stop at the session key,",
  "so the proofs in this file are the only public way to check the part of the",
  "exchange most likely to be wrong."
]

const rendered = (
  vectors: ReadonlyArray<readonly [name: string, bytes: Uint8Array]>
): string =>
  [
    "/**",
    " * Apple's own SRP test vectors, from the ADK's crypto tests.",
    " *",
    " * The inputs are RFC 5054 Appendix B's `alice`/`password123` recomputed for",
    " * the 3072-bit group and SHA-512. `m1` and `m2` are the valuable part: the",
    " * published specification's vectors stop at the session key, and the proofs",
    " * are where this SRP departs from both RFC 2945 and RFC 5054.",
    " */",
    "export const SrpVectors = {",
    ...vectors.map(([name, bytes]) =>
      `  ${name.replace("srp_", "")}: Uint8Array.from([${Array.from(bytes).join(", ")}]),`
    ),
    "} as const",
    ""
  ].join("\n")

/**
 * `Generated/Vectors.ts`.
 *
 * A test file with no `srp_` arrays in it is a failure rather than an empty
 * table: it means the vectors have moved, and an empty `SrpVectors` would make
 * every test that depends on them vacuous instead of red.
 */
export const Vectors: Module = {
  exports: ["SrpVectors"],
  render: (sources) => {
    const names = [...sources.tests.matchAll(DECLARED)].map((match) => match[1] ?? "")
    return names.length === 0
      ? Effect.fail(
        new Error(
          "no `static const uint8_t srp_…[] = {` declarations in HAPCryptoTest.c — " +
            "the SRP vectors have moved or been renamed"
        )
      )
      : Effect.forEach(names, (name) =>
        Schema.decodeUnknownEffect(Cee.byteArray(name))(sources.tests).pipe(
          Effect.map((bytes) => [name, bytes] as const)
        )).pipe(
          Effect.map((vectors) =>
            [
              generated(["packages/airplay/vendor/HAPCryptoTest.c  (Apache-2.0)"], PROSE),
              ``,
              rendered(vectors)
            ].join("\n")
          )
        )
  }
}
