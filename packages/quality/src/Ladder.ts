// The quality ladder: the fixed set of rungs a stream may occupy.
//
// Rungs are strictly increasing in bitrate, so "one rung up" always means
// better and the controller can reason about direction without comparing
// heights and bitrates separately.

import { Array, Order } from "effect"
import { Bitrate, Height, Rung } from "@castcli/domain"

interface LadderOptions {
  readonly sourceHeight: number
  readonly sourceBitrate: number | null
  /** Whether the source can be passed through without re-encoding. */
  readonly canCopy: boolean
}

const ENCODED_RUNGS: ReadonlyArray<readonly [height: number, bitrate: number]> = [
  [360, 800_000],
  [480, 1_200_000],
  [540, 1_800_000],
  [720, 2_500_000],
  [720, 4_000_000],
  [1080, 6_000_000]
]

export const build = (options: LadderOptions): ReadonlyArray<Rung> => {
  const encoded = ENCODED_RUNGS
    .filter(([height]) => height <= options.sourceHeight)
    .map(([height, bitrate]) =>
      Rung.Encode({ height: Height.make(height), bitrate: Bitrate.make(bitrate) })
    )

  // Copying is both the best quality and the cheapest CPU, so it belongs at the
  // top of any ladder whose link can carry it.
  const copy = options.canCopy && options.sourceBitrate !== null
    ? [Rung.Copy({
      height: Height.make(options.sourceHeight),
      bitrate: Bitrate.make(options.sourceBitrate)
    })]
    : []

  // Sorted and deduped by bitrate through Effect's combinators: subtraction as
  // a comparator is wrong for large or non-finite values, and the hand-written
  // dedupe had to index the previous element.
  return Array.dedupeWith(
    Array.sortWith([...encoded, ...copy], (rung) => rung.bitrate, Order.Number),
    (a, b) => a.bitrate === b.bitrate
  )
}

/** Index of the rung to start on: low enough that the picture appears at once. */
export const startingIndex = (ladder: ReadonlyArray<Rung>): number =>
  Math.max(0, Math.min(2, ladder.length - 1))
