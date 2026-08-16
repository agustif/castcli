// The completeness of the key-derivation tables, checked against the source
// they were generated from.
//
// Every other test in this directory checks that a value is *right*. This one
// checks that no value is *missing*, which is a different and much quieter
// failure. A table of HKDF salts is easy to make plausible and hard to make
// complete: name the salts you know about, they extract cleanly, the output
// looks right, and the one nobody thought of is simply absent. Nothing fails.
// The symptom arrives later, from a device, as an authentication error with no
// indication that a constant was never read.
//
// So this reads the two vendored implementation files itself, with its own
// scan, and asserts that every string in them that looks like key material
// appears in the generated tables. Its own scan on purpose: the generator uses
// `Cee.stringLiterals`, and a test that reused the same extractor would agree
// with the generator about a literal neither of them can see. Twenty lines of
// regular expression here are worth more than perfect reuse, because they fail
// independently.
//
// What it is really guarding is Apple's next revision. `Pair-Resume-*` and
// `Pair-Verify-ResumeSessionID-*` are in these files and not in the published
// specification; the revision after this one will add something else, and this
// test is what turns that from an absence into a red build.

import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import * as path from "node:path"
import { Info, Nonce, NonceLabel, Salt, SrpUsername } from "../src/Generated/index.ts"

const VENDOR = path.resolve(import.meta.dirname, "../vendor")

/**
 * Every string literal in a C file, quotes stripped.
 *
 * The body is `[^"\\]|\\.` rather than `[^"]` so that a literal containing an
 * escaped quote is one match instead of two truncated ones — without that, a
 * scan re-synchronises on the wrong quote and starts reporting the code
 * *between* two strings as if it were a string.
 *
 * Comments are not removed, which is deliberate laziness that happens to be
 * safe here: a comment containing a quoted `-Salt` would be a false positive,
 * and a false positive in this test is a person reading a C file, not a silent
 * gap. The reverse mistake is the one that costs.
 */
const literalsIn = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? "")

/**
 * The two vendored files, through the `FileSystem` service rather than
 * `node:fs` — the same reason everything else in this codebase does.
 */
const vendored = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const setup = yield* fs.readFileString(path.join(VENDOR, "HAPPairingPairSetup.c"))
  const verify = yield* fs.readFileString(path.join(VENDOR, "HAPPairingPairVerify.c"))
  return { setup, verify, literals: [...literalsIn(setup), ...literalsIn(verify)] }
}).pipe(Effect.provide(NodeServices.layer))

/**
 * What counts as key material, stated independently of the generator.
 *
 * No whitespace, and either a `Salt`/`Info` suffix or a message label. The
 * whitespace rule is what separates a constant from the log messages that
 * surround it — `"Pair Verify M2: AccessoryInfo"` ends in `Info` and is a
 * sentence — and it holds because every HKDF parameter in these files is a
 * single token.
 */
const KEY_MATERIAL = /^(?:\S*(?:Salt|Info)|P[SVR]-Msg[0-9]{2})$/

/**
 * The naming rule, restated: dashes dropped, a trailing `Salt` or `Info` kept
 * in the value and dropped from the key.
 */
const derivedKey = (value: string): string =>
  value.replaceAll("-", "").replace(/(?:Salt|Info)$/, "")

/** The two keys the rule would otherwise spell as a whole sentence. */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  "Control-Read-Encryption-Key": "ControlRead",
  "Control-Write-Encryption-Key": "ControlWrite"
}

/** Everything the generated tables contain, as a flat set of values. */
const GENERATED: ReadonlySet<string> = new Set<string>([
  ...Object.values(Salt),
  ...Object.values(Info),
  ...Object.values(Nonce)
])

describe("the generated pairing strings, against the sources they came from", () => {
  it.effect("finds the literals at all", () =>
    Effect.gen(function*() {
      // Guarding the guard. If the scan silently matched nothing — a moved
      // vendor directory, a renamed file — every assertion below would pass
      // vacuously, and this test would report that a table containing nothing
      // is complete.
      const { literals } = yield* vendored
      assert.isAbove(literals.length, 100, "the vendored sources scanned as almost no strings")
    }))

  it.effect("has every salt, info string and nonce label the sources contain", () =>
    Effect.gen(function*() {
      const { literals } = yield* vendored
      const missing = literals.filter(
        (literal) => KEY_MATERIAL.test(literal) && !GENERATED.has(literal)
      )
      assert.deepStrictEqual(
        missing,
        [],
        "these strings look like key material and are in neither Salt, Info nor Nonce — " +
          "if Apple has added a derivation, run `npm run codegen`"
      )
    }))

  it.effect("invents nothing: every generated value occurs verbatim in a source", () =>
    Effect.gen(function*() {
      // The other direction, and not redundant. The check above cannot catch a
      // row that was typed in rather than read — a salt with a hyphen in the
      // wrong place is absent from the sources and present in the table, and
      // produces a key that is the right length and wrong.
      const { setup, verify } = yield* vendored
      const fabricated = [...GENERATED, SrpUsername].filter(
        (value) => !setup.includes(`"${value}"`) && !verify.includes(`"${value}"`)
      )
      assert.deepStrictEqual(fabricated, [], "these values are in no vendored source")
    }))

  it("keeps the key and the value from drifting apart", () => {
    // The keys are derived from the values — dashes dropped, a trailing `Salt`
    // or `Info` dropped from the key and kept in the value. Restating the rule
    // here is what catches a hand-edit to the generated file, which is the one
    // way these can disagree.
    const rows = [...Object.entries(Salt), ...Object.entries(Info), ...Object.entries(Nonce)]
    const wrong = rows.filter(([key, value]) => key !== (EXCEPTIONS[value] ?? derivedKey(value)))
    assert.deepStrictEqual(wrong, [], "a key does not match the string it stands for")
  })

  it.effect("has a nonce label the nonce construction will accept", () =>
    Effect.gen(function*() {
      // Eight characters is not a style rule. The label is the tail of a
      // twelve-byte nonce whose first four bytes are zero, so a seven
      // character label produces a nonce that is well-formed, unique, and
      // agrees with nothing the other end computed.
      const decode = Schema.decodeUnknownEffect(NonceLabel)
      yield* Effect.forEach(Object.values(Nonce), (label) => decode(label))

      const short = yield* Effect.exit(decode("PS-Msg5"))
      assert.strictEqual(short._tag, "Failure", "a seven-character label was accepted")
    }))

  it.effect("runs SRP under the user name the accessory expects", () =>
    Effect.gen(function*() {
      // HomeKit authenticates the setup code, not an identity, so the user name
      // is the same string for every device — and it is hashed into `x`, so a
      // different one produces a verifier the accessory rejects with an error
      // that says only "authentication".
      const { setup } = yield* vendored
      assert.strictEqual(SrpUsername, "Pair-Setup")
      assert.isTrue(setup.includes(`static const uint8_t userName[] = "Pair-Setup";`))
    }))
})
