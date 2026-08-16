// The published text of an RFC, named as a source format.

import { Schema } from "effect"

/**
 * The published text of an RFC: fixed columns, page breaks, form feeds and all.
 *
 * **Details**
 *
 * Named rather than left as `Schema.String` so a decoding failure reads as "was
 * expecting the text of an RFC" instead of naming no source at all. Every
 * reader in this module starts here, which is what makes the annotation worth
 * carrying: the identifier appears in the issue of whichever reader failed.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Rfc } from "@castcli/source"
 *
 * const read = Schema.decodeUnknownEffect(Rfc.Text)
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const Text = Schema.String.annotate({
  identifier: "RfcText",
  description: "the published plain-text of an RFC"
})
