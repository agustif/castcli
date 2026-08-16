// C source, named as a source format.

import { Schema } from "effect"

/**
 * The text of a C translation unit — a header or an implementation file.
 *
 * **Details**
 *
 * Named rather than left as `Schema.String` for the same reason `Rfc.Text` is:
 * every reader in this module starts here, so the identifier appears in the
 * issue of whichever reader failed and the message says what it was reading
 * rather than only what it could not find.
 *
 * **Gotchas**
 *
 * This is *text*, not a translation unit in the language's sense. Nothing here
 * runs the preprocessor: `#include` is not followed, macros are not expanded,
 * and both arms of an `#if` are visible at once. Every reader below is built
 * knowing that, and says in its own documentation what it does about it.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Cee } from "@castcli/source"
 *
 * const read = Schema.decodeUnknownEffect(Cee.Text)
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const Text = Schema.String.annotate({
  identifier: "CeeSource",
  description: "the text of a C header or implementation file"
})
