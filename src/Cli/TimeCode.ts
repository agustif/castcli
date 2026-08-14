// Positions on the command line: `90`, `1:30`, `1:02:03`.
//
// This was a hand-written `parseTime` that split on colons and reduced. As a
// Schema it validates as well as parses — `--seek banana` now fails at argument
// parsing with a readable message instead of silently seeking to zero — and it
// yields a branded `Seconds` rather than a bare number.

import { Schema, SchemaTransformation } from "effect"
import { Seconds } from "../Domain/Brands.ts"

const pad = (n: number) => String(Math.floor(n)).padStart(2, "0")

/** Render seconds back to `h:mm:ss` for display. */
export const format = (seconds: number): string =>
  `${Math.floor(seconds / 3600)}:${pad((seconds / 60) % 60)}:${pad(seconds % 60)}`

const PATTERN = /^\d+(:\d{1,2}){0,2}$/

/** Colon-separated, most significant first: `ss`, `mm:ss`, or `hh:mm:ss`. */
export const TimeCode = Schema.String.pipe(
  Schema.check(Schema.isPattern(PATTERN)),
  Schema.decodeTo(
    Seconds,
    SchemaTransformation.transform({
      // Produces the *Encoded* side of Seconds (a plain number); the target
      // schema applies the range check and the brand.
      decode: (text: string): number =>
        text.split(":").map(Number).reduce((total, part) => total * 60 + part, 0),
      encode: (seconds: number): string => format(seconds)
    })
  )
)
export type TimeCode = typeof TimeCode.Type


