// Turning read values back into TypeScript.
//
// Everything else in this directory reads: an enum out of a header, a modulus
// out of an RFC, a salt out of an implementation file. This is the one place
// that writes, and it exists so that the generated tree has one shape rather
// than five.
//
// That matters more than it sounds. The output is checked in and diffed on
// every regeneration, so a module that emitted its table with a different
// indent or a different order of `const`, `type` and schema would produce a
// diff on the day it was written and never again — and a reviewer skimming a
// regeneration diff would have to read the layout to find the values. Emitting
// every table through one function means a diff can only ever be a value.
//
// The banner is here for the same reason. It names the vendored files a module
// was read from, and it is the only thing standing between a reader and the
// assumption that these constants were typed in by hand.

import type { Effect } from "effect"
import type { SchemaError } from "effect/Schema"

/**
 * The vendored texts the generated tree is read from.
 *
 * Passed in rather than read here, so that every module in this directory is a
 * pure function of the source it decodes. The one place that touches the file
 * system is the entry point, which means a module can be exercised against a
 * fragment of C in a test without a fixture on disk.
 */
export interface Sources {
  /** `HAPPairing.h` — the TLV, method, error and flag vocabulary. */
  readonly pairing: string
  /** `HAPCryptoTest.c` — Apple's SRP test vectors. */
  readonly tests: string
  /** `rfc5054.txt` — the published text the SRP group comes from. */
  readonly rfc: string
  /** `HAPPairingPairSetup.c` — pair-setup's salts, infos and nonces. */
  readonly setup: string
  /** `HAPPairingPairVerify.c` — pair-verify's and pair-resume's. */
  readonly verify: string
}

/**
 * One file of the generated tree.
 *
 * `exports` is stated rather than derived from the rendered text, because it is
 * also what the tree's `index.ts` is built from: the barrel re-exports exactly
 * these names, so a module that grows an export without saying so here stays
 * invisible to anything importing `Generated` rather than the file directly.
 */
export interface Module {
  readonly exports: ReadonlyArray<string>
  readonly render: (sources: Sources) => Effect.Effect<string, Error | SchemaError>
}

/**
 * The banner every generated file opens with.
 *
 * The source list is the load-bearing part. Somebody who finds a wrong constant
 * needs to know within one screen whether to fix the file or the extraction,
 * and the only thing that tells them is which vendored file it came out of.
 */
export const generated = (
  sources: ReadonlyArray<string>,
  prose: ReadonlyArray<string>
): string =>
  [
    "// Generated from the vendored HomeKit ADK. Do not edit.",
    "//",
    // "// Source: " and "//         " are the same width, so the paths line up
    // under one another and a new source shows in a diff as one added line.
    ...sources.map((source, index) => `${index === 0 ? "// Source: " : "//         "}${source}`),
    "//",
    ...prose.map((line) => (line === "" ? "//" : `// ${line}`)),
    "//",
    "//   npm run codegen   regenerate from packages/airplay/vendor"
  ].join("\n")

/** One row of a table: the name a caller writes, and the value it stands for. */
export interface Entry {
  readonly key: string
  /** Already TypeScript — `19`, or `"Pair-Setup-Encrypt-Salt"` with its quotes. */
  readonly literal: string
}

export interface Table {
  readonly name: string
  readonly doc: string
  /** The sentence above the schema, which differs by what the values are. */
  readonly wire: string
  readonly entries: ReadonlyArray<Entry>
}

/**
 * A named map for building, and a `Schema` over its values for reading.
 *
 * Both come from the same entries, so they cannot disagree. The map is what a
 * caller writes (`TlvType.Salt` rather than `2`); the schema is what decodes a
 * value that arrived from somewhere, and it rejects one this vocabulary does
 * not contain instead of passing it inward.
 *
 * The trailing empty line is deliberate: modules join their blocks with a
 * newline, so a block that ends in one produces the blank line between
 * declarations that the rest of this codebase is written with.
 */
export const table = (spec: Table): string =>
  [
    `/** ${spec.doc} */`,
    `export const ${spec.name} = {`,
    ...spec.entries.map((entry) => `  ${entry.key}: ${entry.literal},`),
    `} as const`,
    ``,
    `export type ${spec.name} = typeof ${spec.name}[keyof typeof ${spec.name}]`,
    ``,
    `/** ${spec.wire} */`,
    `export const ${spec.name}FromWire = Schema.Literals([`,
    ...spec.entries.map((entry) => `  ${entry.literal},`),
    `])`,
    ``
  ].join("\n")

/** Where this codebase wraps, so generated source reads like written source. */
const COLUMNS = 100

/**
 * One re-export, on one line if it fits and one name per line if it does not.
 *
 * Wrapping by width rather than by count keeps the common case — a module with
 * a single export — from becoming three lines, while stopping the eight names
 * of the vocabulary from running off the side of a diff.
 */
const reexport = (file: string, names: ReadonlyArray<string>): string => {
  const line = `export { ${names.join(", ")} } from "./${file}"`
  return line.length <= COLUMNS
    ? line
    : [`export {`, ...names.map((name) => `  ${name},`), `} from "./${file}"`].join("\n")
}

/**
 * The tree's `index.ts`: what the directory offers, and nothing else.
 *
 * Names are listed explicitly rather than star-exported. A `export *` barrel
 * would re-export whatever a module happens to declare, so the difference
 * between the tree's public surface and its internals would stop being visible
 * anywhere — and this directory's whole contract is that what is not named here
 * is private to it.
 */
export const barrel = (
  sources: ReadonlyArray<string>,
  prose: ReadonlyArray<string>,
  modules: ReadonlyArray<readonly [file: string, module: Module]>
): string =>
  [
    generated(sources, prose),
    ``,
    // Sorted by file, and each file's names sorted within it, so the barrel is
    // a function of what the modules export and not of the order they were
    // wired up in — a reordered manifest is then not a diff.
    ...modules
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([file, module]) => reexport(file, module.exports.toSorted())),
    ``
  ].join("\n")
