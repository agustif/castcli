// Generates the HomeKit pairing vocabulary from Apple's own sources.
//
// AirPlay 2 authentication is HomeKit pairing, and the constants involved — TLV
// types, methods, error codes, flags, and the key-derivation strings that go
// with them — are exactly the kind of thing that is correct the day it is
// transcribed and wrong a year later. Apple publishes them in the HomeKit ADK
// under Apache 2.0, so they can be vendored and derived from rather than copied
// by eye.
//
// The ADK is also *newer* than the specification PDF Apple used to distribute.
// `PairResume` and the `SessionID` TLV type appear there and not in the PDF; so
// do the HKDF salts and info strings, which the published specification omits
// entirely — it names `SessionKey` without ever saying how it is derived.
// Generating means the difference shows up as a diff rather than as a message a
// device answers with an error nobody can look up.
//
//   npm run codegen        regenerate
//   npm run codegen:check  fail if the checked-in output is stale
//
// This file is the only part of the generator that touches the file system. It
// reads the vendored sources, hands their text to the modules in `hap/`, and
// either writes what they return or compares it — so the decoding is testable
// without fixtures and the I/O is in one place.

import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as process from "node:process"
import { barrel, Group, type Module, type Sources, Strings, Vectors, Vocabulary } from "./hap/index.ts"

const ROOT = path.resolve(import.meta.dirname, "..")
const VENDOR = path.join(ROOT, "packages/airplay/vendor")
const OUTPUT = path.join(ROOT, "packages/airplay/src/Generated")

const vendored = (file: string): string => readFileSync(path.join(VENDOR, file), "utf8")

/**
 * The generated tree, in the order a reader meets it.
 *
 * A tree rather than one file, because the four things in it have four
 * different reasons to change: the enums move when Apple revises the ADK, the
 * group never moves at all, the vectors move when their test file does, and the
 * strings move when a new derivation is added. In one file every one of those
 * produced a diff against the same 12KB blob.
 */
const MODULES: ReadonlyArray<readonly [file: string, module: Module]> = [
  ["Vocabulary.ts", Vocabulary],
  ["Group.ts", Group],
  ["Vectors.ts", Vectors],
  ["Strings.ts", Strings]
]

const SOURCES: ReadonlyArray<string> = [
  "packages/airplay/vendor/HAPPairing.h  (Apache-2.0)",
  "packages/airplay/vendor/HAPPairingPairSetup.c",
  "packages/airplay/vendor/HAPPairingPairVerify.c",
  "packages/airplay/vendor/HAPCryptoTest.c",
  "packages/airplay/vendor/rfc5054.txt"
]

const PROSE = [
  "AirPlay 2 authentication is HomeKit pairing. Everything here goes on the",
  "wire or into a key, and a device answers a wrong value with an error nobody",
  "can look up — so all of it is derived from Apple's own sources rather than",
  "transcribed. What is not named below is private to this directory.",
  "",
  "  Vocabulary  TLV types, methods, errors, flags",
  "  Group       the 3072-bit SRP group",
  "  Vectors     Apple's SRP test vectors",
  "  Strings     HKDF salts and info strings, and nonce labels"
]

/** Every file of the tree, as `[relative path, contents]`. */
const rendered = (sources: Sources) =>
  Effect.forEach(MODULES, ([file, module]) =>
    module.render(sources).pipe(Effect.map((contents) => [file, contents] as const))).pipe(
      Effect.map((files) => [...files, ["index.ts", barrel(SOURCES, PROSE, MODULES)] as const])
    )

const check = (file: string, contents: string) =>
  Effect.try({
    try: () => readFileSync(path.join(OUTPUT, file), "utf8"),
    catch: () =>
      new Error(
        `${path.relative(ROOT, path.join(OUTPUT, file))} is missing — run \`npm run codegen\``
      )
  }).pipe(
    Effect.flatMap((existing) =>
      existing === contents ? Effect.void : Effect.fail(
        new Error(
          `${path.relative(ROOT, path.join(OUTPUT, file))} is stale — run \`npm run codegen\``
        )
      )
    )
  )

const write = (file: string, contents: string) =>
  Effect.sync(() => {
    mkdirSync(OUTPUT, { recursive: true })
    writeFileSync(path.join(OUTPUT, file), contents)
  })

const main = Effect.gen(function*() {
  const files = yield* rendered({
    pairing: vendored("HAPPairing.h"),
    tests: vendored("HAPCryptoTest.c"),
    rfc: vendored("rfc5054.txt"),
    setup: vendored("HAPPairingPairSetup.c"),
    verify: vendored("HAPPairingPairVerify.c")
  })

  return yield* process.argv.includes("--check")
    ? Effect.forEach(files, ([file, contents]) => check(file, contents)).pipe(
      Effect.andThen(Effect.logInfo("hap pairing vocabulary is up to date"))
    )
    : Effect.forEach(files, ([file, contents]) => write(file, contents)).pipe(
      Effect.andThen(
        Effect.logInfo(
          `wrote ${files.length} files to ${path.relative(ROOT, OUTPUT)}`
        )
      )
    )
})

NodeRuntime.runMain(main)
