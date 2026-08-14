// A rung on the quality ladder.
//
// `Copy` and `Encode` are genuinely different things rather than one thing with
// a flag: `Copy` passes the source through untouched and its bitrate is an
// observation of the file, while `Encode` re-encodes and its bitrate is a
// target we impose. Modelling that as a tagged union means `Match.exhaustive`
// forces every site that builds encoder arguments to handle both.

import { Data, Match } from "effect"
import type { Bitrate, Height } from "./Brands.ts"

export type Rung = Data.TaggedEnum<{
  readonly Copy: { readonly height: Height; readonly bitrate: Bitrate }
  readonly Encode: { readonly height: Height; readonly bitrate: Bitrate }
}>

export const Rung = Data.taggedEnum<Rung>()

export const describe: (rung: Rung) => string = Match.type<Rung>().pipe(
  Match.tag("Copy", (rung) => `${rung.height}p original (stream copy)`),
  Match.tag("Encode", (rung) => `${rung.height}p @ ${(rung.bitrate / 1_000_000).toFixed(1)} Mbps`),
  Match.exhaustive
)

/** Ordering key. Copying is the top of any ladder it appears in. */
export const bitrateOf = (rung: Rung): number => rung.bitrate
