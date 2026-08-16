// What comes out of reading a C enum.

import { Schema } from "effect"

/**
 * One member of a C enum: the part of the name after the family prefix, and
 * the number the compiler would give it.
 *
 * **Details**
 *
 * `name` has the prefix stripped, because the prefix is what the caller asked
 * for and repeating it in every member makes the generated output read
 * `TlvType.kHAPPairingTLVType_Salt`. The prefix is recoverable — it is the
 * argument that produced this list — so nothing is lost.
 *
 * `value` is a `number` rather than a `bigint`. Every enum in this domain is a
 * `uint8_t` or a `uint32_t` and the values go into generated TypeScript that
 * compares against bytes off the wire; a `bigint` there would need converting
 * at every use.
 *
 * @example
 * ```ts
 * import type { Member } from "./Member.ts"
 *
 * const flag: Member = { name: "Transient", value: 16 }
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export const Member = Schema.Struct({
  name: Schema.String,
  value: Schema.Number
})

/**
 * @category models
 * @since 0.1.0
 */
export type Member = typeof Member.Type

/**
 * The members of one enum, in the order the source declares them.
 *
 * **Gotchas**
 *
 * Source order, not value order. A generated table that renumbers itself
 * because someone sorted it reads as a diff on every unrelated change, and the
 * declaration order is also the order Apple's own documentation lists them in.
 *
 * @category models
 * @since 0.1.0
 */
export const Members = Schema.Array(Member)

/**
 * @category models
 * @since 0.1.0
 */
export type Members = typeof Members.Type
