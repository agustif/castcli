// The salts, infos and nonce labels HAP's published specification omits.
//
// The R2 specification names `SessionKey` and never says how it is derived. The
// derivation is HKDF-SHA-512 over the SRP session key with a salt and an info
// string, both of which are fixed ASCII constants, and both of which appear
// only in the implementation. An implementation that guesses either one gets a
// key that is the right length and wrong, and the first symptom is message five
// of pair-setup failing with an error whose only content is "authentication".
// That is why `HAPPairingPairSetup.c` and `HAPPairingPairVerify.c` were
// vendored, and it is why nothing here is typed in.
//
// Two problems have to be solved to read them, and they pull in opposite
// directions.
//
// The first is that they are not named constants in any useful sense. Every one
// of them is a function-local `static const uint8_t salt[]`, `info[]` or
// `nonce[]`, and there are eight `salt`s, thirteen `info`s and seven `nonce`s,
// each with different contents. `Cee.stringLiteral("salt")` refuses to answer
// that — correctly, since there is no such thing as "the value of salt" in that
// file — so the values are taken from `Cee.stringLiterals`, the survey of every
// literal in the file, and classified by what they say they are.
//
// The second is completeness, and it is the reason the survey is the right tool
// rather than a concession. A table of key-derivation constants is easy to make
// plausible and hard to make complete: name the salts you know about, they
// extract cleanly, the output looks right, and the one nobody thought of is
// simply absent. So the survey is used in both directions. Everything that
// looks like key material is classified into the tables, and everything left
// over has to be named here as *not* being key material — which means Apple's
// next revision adding a salt stops the generator instead of quietly not
// existing.

import { Effect, Schema } from "effect"
import type { SchemaError } from "effect/Schema"
import { Cee } from "@castcli/source"
import { generated, type Module, table } from "./Render.ts"

/**
 * A nonce label, exactly as HAP spells them.
 *
 * `PS`, `PV` and `PR` are pair-setup, pair-verify and pair-resume; the two
 * digits are the message number within the exchange. Every one of them is eight
 * characters, which is not a coincidence — the label is the tail of a twelve
 * byte nonce whose first four bytes are zero, so a label of any other length
 * would produce a nonce that is perfectly valid and agrees with nothing.
 */
const NONCE = /^P[SVR]-Msg[0-9]{2}$/

/**
 * A literal that looks like key material even though it has whitespace in it.
 *
 * The suffix rules below only consider literals with no whitespace, because
 * every key-derivation constant in these files is a single token and the log
 * messages that surround them are not. This is the second half of that rule: a
 * *sentence* ending in `-Salt`, or containing a message label, is far more
 * likely to be a constant somebody wrote oddly than a log line, so it is
 * reported rather than assumed to be prose.
 */
const SUSPICIOUS = /-(?:Salt|Info)$|P[SVR]-Msg[0-9]{2}/

/**
 * The HKDF info strings whose spelling does not say what they are.
 *
 * Four of the thirteen info strings do not end in `-Info`. Two are the control
 * channel's — `Control-Read-Encryption-Key` and `Control-Write-Encryption-Key`,
 * the keys the encrypted session that follows pair-verify runs under — and two
 * are the transient split-setup pair, used with `SplitSetupSalt`. Nothing in
 * the string itself distinguishes them from a log tag, so they are named. This
 * list is the only place in this module where a human decided what something
 * is, and the completeness check below is what stops that decision from
 * silently going out of date.
 */
const INFOS: ReadonlySet<string> = new Set([
  "AccessoryEncrypt-Control",
  "ControllerEncrypt-Control",
  "Control-Read-Encryption-Key",
  "Control-Write-Encryption-Key"
])

/**
 * Keys that the mechanical rule would spell unhelpfully.
 *
 * The rule — drop the dashes, drop a trailing `Salt` or `Info` — gives
 * `ControlReadEncryptionKey` for the control channel's read key, which repeats
 * in the key everything the reader already knows from `Info.`. These two are
 * the exception, and stating them here keeps the exception in one place instead
 * of in the shape of the rule.
 */
const KEYS: Readonly<Record<string, string>> = {
  "Control-Read-Encryption-Key": "ControlRead",
  "Control-Write-Encryption-Key": "ControlWrite"
}

/**
 * Literals in these two files that are not key material.
 *
 * The two log-object categories, the two flag names that appear as `%s`
 * arguments, and the two words a boolean is formatted as. Listing them is what
 * lets the completeness check be an inverse: anything with no whitespace that
 * is neither classified nor listed here fails the generator. That is
 * deliberately noisier than checking only for `-Salt` and `-Info` suffixes,
 * because the four `INFOS` above are proof that a new constant need not
 * announce itself in its own spelling.
 */
const NOT_KEY_MATERIAL: ReadonlySet<string> = new Set([
  "PairingPairSetup",
  "PairingPairVerify",
  "kPairingFlag_Transient",
  "kPairingFlag_Split",
  "true",
  "false"
])

/** The C identifier the SRP user name is declared under, uniquely, in setup. */
const USERNAME = "userName"

type Category = "Salt" | "Info" | "Nonce"

/**
 * What a literal is, from what it says it is.
 *
 * Whitespace disqualifies before anything else, and that is not a nicety. These
 * files log almost every step, and `"Pair Verify M2: AccessoryInfo"` is a log
 * message that ends in `Info`. Without the guard it classifies as an info
 * string and lands in the table with a key built out of a sentence — which does
 * not even parse as TypeScript, and would have been a plausible-looking row if
 * it had. No key-derivation constant in either file contains a space.
 *
 * Then suffix, then the named exceptions. A literal this returns `undefined`
 * for is either not key material or a kind of key material this generator has
 * never seen, and the caller cannot tell those apart — which is exactly why it
 * refuses to guess and stops instead.
 */
const categoryOf = (value: string): Category | undefined =>
  /\s/.test(value)
    ? undefined
    : NONCE.test(value)
    ? "Nonce"
    : value.endsWith("Salt")
    ? "Salt"
    : value.endsWith("Info") || INFOS.has(value)
    ? "Info"
    : undefined

/**
 * The name a caller writes, derived from the string itself.
 *
 * Every dash removed, the words otherwise kept as they are, and a trailing
 * `Salt` or `Info` dropped from the key but kept in the value — so
 * `Salt.PairSetupEncrypt` is `"Pair-Setup-Encrypt-Salt"` and the two cannot
 * drift apart. Deriving the key rather than choosing it means a constant added
 * upstream lands in the table with a predictable name instead of waiting for
 * somebody to invent one.
 */
const keyOf = (value: string): string =>
  KEYS[value] ?? value.replaceAll("-", "").replace(/(?:Salt|Info)$/, "")

interface Vendored {
  readonly username: string
  readonly literals: ReadonlyArray<string>
}

/**
 * Every string literal in both files, in source order, with the SRP user name
 * read separately by its identifier.
 *
 * `userName` is the one constant in either file that has a unique name, so it
 * is the one that can be read the way `Cee` prefers — by asking for it. Reading
 * it that way rather than picking `"Pair-Setup"` out of the survey means a
 * rename is a decoding failure that names the identifier, instead of the user
 * name quietly becoming whatever else happens to be spelled that way.
 */
const read = (setup: string, verify: string): Effect.Effect<Vendored, SchemaError> =>
  Effect.all({
    username: Schema.decodeUnknownEffect(Cee.stringLiteral(USERNAME))(setup),
    inSetup: Schema.decodeUnknownEffect(Cee.stringLiterals)(setup),
    inVerify: Schema.decodeUnknownEffect(Cee.stringLiterals)(verify)
  }).pipe(
    Effect.map(({ inSetup, inVerify, username }) => ({
      username,
      literals: [...inSetup, ...inVerify]
    }))
  )

/**
 * Everything the tables do not account for.
 *
 * The check that gives this module its point. A literal has to be classified,
 * be the user name, or be listed as not key material — and if it is none of
 * those, the generator stops with it quoted. The alternative is a table that is
 * quietly one entry short, which looks exactly like a table that is complete.
 */
const unaccounted = (vendored: Vendored): ReadonlyArray<string> =>
  vendored.literals.filter(
    (value) =>
      (SUSPICIOUS.test(value) || !/\s/.test(value)) &&
      value !== vendored.username &&
      !NOT_KEY_MATERIAL.has(value) &&
      categoryOf(value) === undefined
  )

const CATEGORIES: ReadonlyArray<Category> = ["Salt", "Info", "Nonce"]

const entriesFor = (vendored: Vendored, category: Category) =>
  vendored.literals
    .filter((value) => categoryOf(value) === category)
    .map((value) => ({ key: keyOf(value), literal: JSON.stringify(value) }))

const PROSE = [
  "The HKDF salts and info strings, and the nonce labels each encrypted",
  "pairing message is sealed under. The published specification names",
  "`SessionKey` without saying how it is derived; these are the derivation, so",
  "they are read out of Apple's implementation rather than guessed."
]

/**
 * The nonce label brand, emitted alongside the table.
 *
 * The table is the labels HAP uses today. The brand is the shape a label has to
 * have at all, and it exists because the two failures are different: an
 * unrecognised label is caught by `NonceFromWire`, but a *mistyped* one — seven
 * characters, or a stray non-ASCII character pasted from a document — is a
 * valid string that produces a misaligned nonce, and the only symptom is a
 * forged-frame failure at the far end of an exchange.
 */
const LABEL = [
  "/**",
  " * Exactly eight printable ASCII characters, which every HAP nonce label is.",
  " *",
  " * The label is the tail of a twelve byte nonce whose leading four bytes are",
  " * zero, so a seven-character label does not fail — it produces a nonce that is",
  " * silently misaligned against the one the other end computed, and the only",
  " * symptom is an authentication tag that does not verify several messages later.",
  " * ASCII because the label is encoded as UTF-8: a character above U+007F is more",
  " * than one byte, so eight *characters* would not be eight *bytes*.",
  " *",
  " * `NonceFromWire` is the narrower check and this is the wider one. A label that",
  " * is merely unrecognised is caught there; this catches one that could not be a",
  " * label at all, including a label this table has not yet been regenerated for.",
  " */",
  "export const NonceLabel = Schema.String.pipe(",
  "  Schema.check(",
  "    Schema.isLengthBetween(8, 8, {",
  "      message: \"a nonce label is 8 characters, such as PS-Msg05\"",
  "    }),",
  "    Schema.isPattern(/^[\\x20-\\x7e]*$/, {",
  "      message: \"a nonce label is printable ASCII\"",
  "    })",
  "  ),",
  "  Schema.brand(\"NonceLabel\")",
  ")",
  "",
  "export type NonceLabel = typeof NonceLabel.Type",
  ""
]

const rendered = (vendored: Vendored): string =>
  [
    generated(
      [
        "packages/airplay/vendor/HAPPairingPairSetup.c  (Apache-2.0)",
        "packages/airplay/vendor/HAPPairingPairVerify.c"
      ],
      PROSE
    ),
    ``,
    `import { Schema } from "effect"`,
    ``,
    table({
      name: "Salt",
      doc: "HKDF salts, named for the derivation each one belongs to.",
      wire: "The same values, as a schema, for decoding a salt that came from elsewhere.",
      entries: entriesFor(vendored, "Salt")
    }),
    table({
      name: "Info",
      doc: "HKDF info strings. Paired with a salt; the two are never mixed across rows.",
      wire: "The same values, as a schema, for decoding an info string that came from elsewhere.",
      entries: entriesFor(vendored, "Info")
    }),
    table({
      name: "Nonce",
      doc: "The label naming each encrypted message of an exchange.",
      wire: "The same values, as a schema, for decoding a label a device sent.",
      entries: entriesFor(vendored, "Nonce")
    }),
    LABEL.join("\n"),
    [
      "/**",
      " * The SRP user name pair-setup runs under.",
      " *",
      " * Fixed, and not the controller's or the accessory's identifier: HomeKit",
      " * authenticates the *setup code*, so the user name carries no identity and is",
      " * the same string for every device. It is hashed into `x`, so a different one",
      " * produces a different verifier and a proof the accessory rejects.",
      " */",
      `export const SrpUsername = ${JSON.stringify(vendored.username)}`,
      ""
    ].join("\n")
  ].join("\n")

/**
 * `Generated/Strings.ts`.
 *
 * `Pair-Resume-*`, `MFi-Pair-Setup-*` and `SplitSetupSalt` come out under the
 * same mechanical naming as the rest. Deciding by hand which of them this
 * project will use would put the decision in the generator, where it cannot be
 * revisited without regenerating; putting all of them in the table costs a few
 * lines and leaves the choice to the code that derives keys.
 */
export const Strings: Module = {
  exports: [
    "Info",
    "InfoFromWire",
    "Nonce",
    "NonceFromWire",
    "NonceLabel",
    "Salt",
    "SaltFromWire",
    "SrpUsername"
  ],
  render: (sources) =>
    read(sources.setup, sources.verify).pipe(
      Effect.flatMap((vendored) => {
        const missing = unaccounted(vendored)
        // An empty category is the other silent failure, and the completeness
        // check cannot see it: if every salt were renamed at once there would
        // be nothing left over to report, and `Salt = {}` would generate,
        // compile, and be imported by code that then derives no keys at all.
        const empty = CATEGORIES.filter((category) => entriesFor(vendored, category).length === 0)
        return missing.length === 0 && empty.length === 0
          ? Effect.succeed(rendered(vendored))
          : Effect.fail(
            new Error(
              empty.length > 0
                ? `the vendored pairing sources contain no ${empty.join(", ")} at all — ` +
                  `the constants have been renamed, and an empty table would generate ` +
                  `and compile`
                : `${missing.length} string literal(s) in the vendored pairing sources are ` +
                  `neither in the generated tables nor listed as not being key material: ` +
                  `${missing.map((value) => JSON.stringify(value)).join(", ")}. ` +
                  `If one of them is a salt, an info string or a nonce label, it belongs ` +
                  `in the tables; if not, add it to NOT_KEY_MATERIAL in ` +
                  `scripts/hap/Strings.ts and say why.`
            )
          )
      })
    )
}
