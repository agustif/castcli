// A family of enum constants, read out of Apple's own header.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { NodeServices } from "@effect/platform-node"
import { Cee } from "@castcli/source"
import { GUARDED, HAP_PAIRING_H, HAP_PAIRING_PAIR_SETUP_C } from "../Vendor.ts"

const decode = <S extends Schema.ConstraintCodec<unknown, string, never, never>>(
  schema: S,
  text: string
) => Schema.decodeUnknownEffect(schema)(text)

const readFile = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem
    return yield* fs.readFileString(path)
  }).pipe(Effect.provide(NodeServices.layer))

const valueOf = (members: Cee.Members, name: string) =>
  members.find((member) => member.name === name)?.value

describe("Cee.enumeration over the vendored HomeKit header", () => {
  it.effect("reads the TLV types, including the two out-of-sequence ones", () =>
    Effect.gen(function*() {
      const types = yield* decode(Cee.enumeration("kHAPPairingTLVType_"), yield* readFile(HAP_PAIRING_H))

      // Seventeen, not sixteen. The count is asserted against what the header
      // actually declares, and the header declares a `Separator` after `Flags`
      // that older summaries of this enum leave out — which is the whole reason
      // to read the source rather than a summary of it.
      assert.strictEqual(types.length, 17)
      assert.strictEqual(valueOf(types, "Method"), 0)
      // Both of these are numbered out of sequence with their neighbours, so a
      // reader that inferred values from position would produce a table that is
      // wrong from `SessionID` onwards and right up to it.
      assert.strictEqual(valueOf(types, "SessionID"), 14)
      assert.strictEqual(valueOf(types, "Flags"), 19)
      assert.strictEqual(valueOf(types, "Separator"), 255)
    }))

  it.effect("reads the last member of an enum, which has no trailing comma", () =>
    Effect.gen(function*() {
      const methods = yield* decode(Cee.enumeration("kHAPPairingMethod_"), yield* readFile(HAP_PAIRING_H))

      // This is the regression. The generator that used to read this header
      // matched an enum value with `[^,;)]+`, which stops at a comma — and the
      // last member of an enum has none. `PairResume` was dropped, the table
      // had six entries where the header has seven, and nothing failed.
      assert.strictEqual(methods.length, 7)
      assert.strictEqual(valueOf(methods, "PairResume"), 6)
    }))

  it.effect("evaluates the shift expressions a flags enum is written with", () =>
    Effect.gen(function*() {
      const flags = yield* decode(Cee.enumeration("kHAPPairingFlag_"), yield* readFile(HAP_PAIRING_H))

      assert.strictEqual(valueOf(flags, "Transient"), 16)
      assert.strictEqual(valueOf(flags, "Split"), 16777216)
    }))

  it.effect("reads the error codes", () =>
    Effect.gen(function*() {
      const errors = yield* decode(Cee.enumeration("kHAPPairingError_"), yield* readFile(HAP_PAIRING_H))

      assert.strictEqual(errors.length, 7)
      assert.strictEqual(valueOf(errors, "Authentication"), 2)
    }))

  it.effect("does not mistake a use of a constant for a declaration of one", () =>
    Effect.gen(function*() {
      // The pairing implementation mentions `kHAPPairingTLVType_` on nearly
      // every page — `tlv->type == kHAPPairingTLVType_State`, `.type =
      // kHAPPairingTLVType_Salt` — and declares none of them. Without the guard
      // on `==`, a comparison's right-hand side is recorded as a value; without
      // the guard on which side of the `=` the name sits, every designated
      // initialiser becomes a member.
      const result = yield* Effect.exit(
        decode(Cee.enumeration("kHAPPairingTLVType_"), yield* readFile(HAP_PAIRING_PAIR_SETUP_C))
      )
      assert.isTrue(result._tag === "Failure", "found enum declarations in a file that has none")
    }))
})

describe("Cee.enumeration", () => {
  it.effect("keeps the first of a name declared twice under a preprocessor guard", () =>
    Effect.gen(function*() {
      // Nothing here runs the preprocessor, so both arms of an `#if` are
      // visible and one of them is not compiled. First-wins matches how these
      // headers are written: the guarded second definition is the fallback for
      // a platform this project is not.
      const things = yield* decode(Cee.enumeration("kThing_"), GUARDED)

      assert.deepStrictEqual(things.map((thing) => thing.name), ["First", "Second", "Last"])
      assert.strictEqual(valueOf(things, "Second"), 1)
      assert.strictEqual(valueOf(things, "Last"), 2)
    }))

  it.effect("fails on a prefix that matches nothing, rather than returning nothing", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(decode(Cee.enumeration("kMissing_"), GUARDED))
      // An empty vocabulary is the shape a rename produces, and it is silent
      // everywhere downstream — so the message has to name the prefix.
      assert.include(error.message, "kMissing_")
    }))

  it.effect("fails on a member whose value it cannot evaluate, naming the member", () =>
    Effect.gen(function*() {
      const source = `enum { kThing_A = 0x01, kThing_B = SOME_MACRO(2) };`
      const error = yield* Effect.flip(decode(Cee.enumeration("kThing_"), source))

      // Skipping what will not evaluate turns a gap in the evaluator into a
      // missing constant, and generated output that is short by one entry looks
      // exactly like generated output.
      assert.include(error.message, "kThing_B")
      assert.include(error.message, "SOME_MACRO(2)")
    }))

  it.effect("round-trips a family back out as an enum body", () =>
    Effect.gen(function*() {
      const codec = Cee.enumeration("kHAPPairingFlag_")
      const flags = yield* decode(codec, yield* readFile(HAP_PAIRING_H))
      const written = yield* Schema.encodeEffect(codec)(flags)

      // The only check that the reader agrees with itself about where a
      // member's value ends: the written form has a trailing comma on every
      // line, including the last, which is the case the original regression
      // could not read.
      assert.deepStrictEqual(yield* decode(codec, written), flags)
    }))
})
