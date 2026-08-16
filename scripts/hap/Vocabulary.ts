// The pairing vocabulary: the numbers that go on the wire.
//
// Four families of enum constants live in Apple's `HAPPairing.h` — the TLV item
// types, the pairing methods, the error codes a device declines with, and the
// flags that modify pair-setup. Every one of them is a small integer that has
// to match the other end exactly, and every one of them is written down in that
// header, so the header is what this reads.
//
// It used to read it with a regular expression, and that regular expression
// stopped the value of a member at a comma. The last member of an enum has no
// trailing comma — it is terminated by the closing brace, usually on the next
// line — so `kHAPPairingMethod_PairResume` was silently dropped and the
// generated table had six methods where the header has seven. Nothing failed;
// the constant was simply absent, and absence has no symptom until a device
// sends the value and gets an error nobody can look up.
//
// `Cee.enumeration` is the fix, and the reason this module is three lines of
// its own logic: the same mistake is now somebody else's decoding failure
// rather than this generator's silence.

import { Effect, Schema } from "effect"
import { Cee } from "@castcli/source"
import { generated, type Module, table } from "./Render.ts"

interface Group {
  /** The C prefix that selects the family, and is stripped from each name. */
  readonly prefix: string
  readonly name: string
  readonly doc: string
}

/**
 * The four families, in the order the generated file declares them.
 *
 * Order is fixed here rather than discovered, because it is the order of the
 * generated file and a table that reshuffled itself would produce a diff on
 * every regeneration that had nothing to do with a changed value.
 */
const GROUPS: ReadonlyArray<Group> = [
  {
    prefix: "kHAPPairingTLVType_",
    name: "TlvType",
    doc: "Item types in a pairing TLV8 payload."
  },
  {
    prefix: "kHAPPairingMethod_",
    name: "PairingMethod",
    doc: "Which pairing exchange a request begins."
  },
  {
    prefix: "kHAPPairingError_",
    name: "PairingError",
    doc: "How a device declines. `Authentication` is a wrong PIN."
  },
  {
    prefix: "kHAPPairingFlag_",
    name: "PairingFlag",
    doc: "Modifiers on pair-setup. `Transient` stops after M4."
  }
]

const PROSE = [
  "AirPlay 2 authentication is HomeKit pairing. These numbers go on the wire",
  "and a device answers a wrong one with an error nobody can look up, so they",
  "are derived from Apple's own header rather than transcribed."
]

const rendered = (group: Group, members: Cee.Members): string =>
  table({
    name: group.name,
    doc: group.doc,
    wire: "The same values, as a schema, for decoding what a device sent.",
    entries: members.map((member) => ({ key: member.name, literal: String(member.value) }))
  })

/**
 * `Generated/Vocabulary.ts`.
 *
 * Each family is read separately, by prefix, so that a family which has been
 * renamed upstream fails on its own rather than being absorbed into another.
 * `Cee.enumeration` fails when a prefix matches nothing at all, which is what
 * turns a rename into a stopped build instead of an empty table.
 */
export const Vocabulary: Module = {
  exports: GROUPS.flatMap((group) => [group.name, `${group.name}FromWire`]),
  render: (sources) =>
    Effect.forEach(GROUPS, (group) =>
      Schema.decodeUnknownEffect(Cee.enumeration(group.prefix))(sources.pairing).pipe(
        Effect.map((members) => rendered(group, members))
      )).pipe(
        Effect.map((blocks) =>
          [
            generated(["packages/airplay/vendor/HAPPairing.h  (Apache-2.0)"], PROSE),
            ``,
            `import { Schema } from "effect"`,
            ``,
            ...blocks
          ].join("\n")
        )
      )
}
