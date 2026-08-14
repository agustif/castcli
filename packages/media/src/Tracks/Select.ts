// Choosing which audio and subtitle track to play.
//
// This module exists because the tool was making a person do work only the tool
// could do. `cast streams` printed two identical lines for the file it was
// built against:
//
//   [4] subtitle subrip spa
//   [5] subtitle subrip spa
//
// Stream 4 is 24 cues of forced signage. Stream 5 is 1670 lines of dialogue.
// The container flags **4** as `default` and neither as `forced`, so the
// obvious heuristic picks the wrong one — the metadata is not merely unhelpful,
// it actively misleads.
//
// The only signal that separates them is how many cues the track contains, and
// obtaining it means extracting the track. That is why subtitle selection is an
// effect while audio selection is a pure function.

import { Array, Effect, Option, Order } from "effect"
import type { MediaProbeError } from "@castcli/domain"
import { type FilePath, type MediaStream, StreamIndex } from "@castcli/domain"
import { Ffmpeg } from "../Ffmpeg/Service.ts"
import type * as Vtt from "../Vtt/Codec.ts"

/**
 * Language preferences, most wanted first, as ISO 639-2 codes.
 *
 * A branded list would add nothing: these come from configuration where the
 * only meaningful validation — "does this file have such a track" — happens
 * here anyway, against the file.
 */
export type Languages = ReadonlyArray<string>

/** Preferred languages first; within a language, the container's order. */
const byPreference = Order.mapInput(Order.Number, (ranked: { readonly rank: number }) => ranked.rank)

/**
 * Streams whose language appears in the preference list, best first.
 *
 * A language that matches nothing is dropped rather than ranked last: ranking
 * would let an unwanted language be chosen whenever nothing better exists,
 * which is how a Spanish-only preference ends up playing Hungarian.
 */
const rankedByLanguage = (
  streams: ReadonlyArray<MediaStream>,
  languages: Languages
): ReadonlyArray<MediaStream> =>
  streams
    .map((stream) => ({ stream, rank: languages.indexOf(stream.language) }))
    .filter(({ rank }) => rank >= 0)
    .toSorted(byPreference)
    .map(({ stream }) => stream)

/**
 * Pick an audio track: the first in the preference order, or — when nothing
 * matches — the container's own default, and failing that the first track.
 *
 * Falling back rather than failing is deliberate. A file whose audio is tagged
 * `und`, which Matroska does for English, would otherwise play silently.
 */
export const chooseAudio = (
  streams: ReadonlyArray<MediaStream>,
  languages: Languages
): Option.Option<MediaStream> =>
  Array.head(rankedByLanguage(streams, languages)).pipe(
    Option.orElse(() => Array.findFirst(streams, (stream) => stream.isDefault)),
    Option.orElse(() => Array.head(streams))
  )

/** A subtitle track and what was learned by reading it. */
export interface SubtitleChoice {
  readonly stream: MediaStream
  readonly cues: Vtt.Cues
  /** Every candidate considered, richest first — for explaining the choice. */
  readonly considered: ReadonlyArray<{
    readonly stream: MediaStream
    readonly cueCount: number
  }>
}

const byCueCountDescending = Order.flip(
  Order.mapInput(Order.Number, (candidate: { readonly cueCount: number }) => candidate.cueCount)
)

/**
 * Which subtitle track wins, given counts someone has already obtained.
 *
 * Separated from the extraction so that `cast streams` — which counts every
 * track in order to show them — can mark the same choice `cast play` would
 * make, instead of a second heuristic drifting away from the first.
 */
export const bestSubtitle = (
  streams: ReadonlyArray<MediaStream>,
  languages: Languages,
  cueCounts: ReadonlyMap<number, number>
): Option.Option<MediaStream> =>
  Option.map(
    Array.head(
      contendersFor(rankedByLanguage(streams, languages))
        .map((stream) => ({ stream, cueCount: cueCounts.get(stream.index) ?? 0 }))
        .toSorted(byCueCountDescending)
    ),
    ({ stream }) => stream
  )

/**
 * Narrow to a single language — the best one that matched. A release with eight
 * subtitle tracks would otherwise cost eight passes over a multi-gigabyte
 * container to answer a question about two of them.
 */
const contendersFor = (ranked: ReadonlyArray<MediaStream>): ReadonlyArray<MediaStream> =>
  Option.match(Array.head(ranked), {
    onNone: () => [],
    onSome: (best) => ranked.filter((stream) => stream.language === best.language)
  })

/**
 * Pick a subtitle track by extracting every candidate in the best available
 * language and keeping the one with the most cues.
 *
 * Only candidates in a *single* language are read — the first preference that
 * matches anything — so the usual cost is one extra ffmpeg run beyond the one
 * that had to happen regardless. The cues come back with the choice, because
 * the caller needs them and re-extracting a track from a multi-gigabyte
 * container is seconds of work already done.
 */
export const chooseSubtitle = Effect.fn("Tracks.chooseSubtitle")(function*(
  file: FilePath,
  streams: ReadonlyArray<MediaStream>,
  languages: Languages
) {
  const ffmpeg = yield* Ffmpeg

  const extracted = yield* Effect.forEach(
    contendersFor(rankedByLanguage(streams, languages)),
    (stream) =>
      Effect.map(
        ffmpeg.extractCues(file, StreamIndex.make(stream.index)),
        (cues) => ({ stream, cues, cueCount: cues.length })
      ),
    { concurrency: 2 }
  )

  const ranked = extracted.toSorted(byCueCountDescending)
  return Option.map(
    Array.head(ranked),
    (best): SubtitleChoice => ({
      stream: best.stream,
      cues: best.cues,
      considered: ranked.map(({ cueCount, stream }) => ({ stream, cueCount }))
    })
  )
}) satisfies (
  file: FilePath,
  streams: ReadonlyArray<MediaStream>,
  languages: Languages
) => Effect.Effect<Option.Option<SubtitleChoice>, MediaProbeError, Ffmpeg>
