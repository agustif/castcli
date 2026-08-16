// The real files, and small fixtures for the shapes they do not contain.
//
// Both, deliberately. Fixtures written by the same hand as the parser agree
// with it by construction, and every bug this family of code has actually had
// came from real source looking different from what the author pictured — the
// enum member with no trailing comma, the doc comment naming other members of
// its own enum, the local `static` reused five times under one name. So the
// assertions that matter run against Apple's own files.
//
// The fixtures below are for the shapes the vendored files happen not to have:
// a preprocessor-guarded redefinition, an octal literal, a comment inside a
// byte array. Those are real C and a reader that got them wrong would be wrong
// on the next header vendored, so they are worth a fixture even without a file
// to point at.

const vendor = (name: string) =>
  new URL(`../../../airplay/vendor/${name}`, import.meta.url).pathname

/** Apple's pairing vocabulary: four enums, one of them a flags enum. */
export const HAP_PAIRING_H = vendor("HAPPairing.h")

/** Apple's crypto test vectors, including the SRP ones. */
export const HAP_CRYPTO_TEST_C = vendor("HAPCryptoTest.c")

/** The pair-setup implementation: every HKDF salt and nonce the exchange uses. */
export const HAP_PAIRING_PAIR_SETUP_C = vendor("HAPPairingPairSetup.c")

/**
 * An enum whose last member has no trailing comma, alongside the same name
 * declared twice in the two arms of a preprocessor conditional.
 *
 * Both are cases where the reader has to do something other than the obvious.
 * The trailing comma is the one that already cost a constant; the guarded
 * redefinition is the one that would produce two entries with the same name and
 * different values if first-wins were dropped.
 */
export const GUARDED = `
enum {
    kThing_First = 0x00,
    kThing_Second = 0x01,
#if THE_OTHER_PLATFORM
    kThing_Second = 0x99,
#endif
    /** The last member, which the compiler ends at the brace. */
    kThing_Last = 0x02
};
`

/**
 * A byte array with a comment inside the braces, a line break in the middle of
 * a row, and a trailing comma before the close.
 *
 * All three occur in formatted C and none of them is the value; a reader that
 * counted commas, or that split on lines, gets a different number of bytes.
 */
export const COMMENTED_BYTES = `
static const uint8_t vector[] = {
    0x00, 0x01, /* two so far */ 0x02,
    // a whole line of commentary
    0x03,
};
`

/**
 * Two identifiers where one contains the other, and a value written in octal.
 *
 * `salt` inside `hkdf_salt` is the boundary case; `010` is 8 to a compiler and
 * 10 to anything that calls `Number` on it, which is a constant that is wrong
 * by two with no other symptom.
 */
export const AWKWARD_NAMES = `
static const uint8_t hkdf_salt[] = "not this one";
static const uint8_t salt[] = "this one";
#define SALT_LENGTH 010
enum { kOctal_Value = 010 };
`
