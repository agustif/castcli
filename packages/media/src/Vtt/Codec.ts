// WebVTT as a Schema codec.
//
// Subtitles are read out of the container once and held as structured cues.
// Serving them any other way caused cues to accumulate on screen instead of
// replacing each other: piping ffmpeg straight into the HTTP response produced
// a chunked reply with no Content-Length that took ~6s to complete, and a Cast
// receiver parses such a track progressively as it arrives rather than as one
// finished file.
//
// Keeping cues in memory also makes seeking free: re-cutting for a new offset
// is a filter and a subtraction instead of another pass over a huge container.
//
// Expressed as a `Codec` so decoding and encoding are one declaration rather
// than two functions that can drift apart.

import { Option, Schema, SchemaTransformation } from "effect"

export const Cue = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  settings: Schema.String,
  text: Schema.String
})
export type Cue = typeof Cue.Type

export const Cues = Schema.Array(Cue)
export type Cues = typeof Cues.Type

const CUE_LINE = /^([\d:.]+)\s*-->\s*([\d:.]+)(.*)$/

/** Parse `HH:MM:SS.mmm` or `MM:SS.mmm` into seconds. */
const parseTimestamp = (value: string): number => {
  const parts = value.trim().split(":")
  const seconds = Number(parts.pop() ?? 0)
  const minutes = Number(parts.pop() ?? 0)
  const hours = Number(parts.pop() ?? 0)
  return hours * 3600 + minutes * 60 + seconds
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0")

const formatTimestamp = (seconds: number): string => {
  const clamped = Math.max(0, seconds)
  return [
    pad(Math.floor(clamped / 3600)),
    pad(Math.floor((clamped / 60) % 60)),
    `${pad(Math.floor(clamped % 60))}.${pad(Math.round((clamped % 1) * 1000), 3)}`
  ].join(":")
}

/**
 * WebVTT is block-structured: cues are separated by blank lines. Splitting on
 * those first means each block parses independently, so this is a flatMap
 * rather than a pair of index-juggling loops. Blocks with no timing line — the
 * `WEBVTT` header, `NOTE` comments — simply yield nothing.
 */
const parseCues = (text: string): Cues =>
  text.split(/\r?\n\s*\r?\n/).flatMap((block): Cues => {
    const lines = block.split(/\r?\n/)
    const timingIndex = lines.findIndex((line) => CUE_LINE.test(line))
    return Option.match(
      Option.fromNullishOr(lines[timingIndex]).pipe(
        Option.flatMap((line) => Option.fromNullishOr(CUE_LINE.exec(line)))
      ),
      {
        onNone: () => [],
        onSome: (match) => [{
          start: parseTimestamp(match[1]!),
          end: parseTimestamp(match[2]!),
          settings: (match[3] ?? "").trim(),
          text: lines.slice(timingIndex + 1).join("\n").trim()
        }]
      }
    )
  })

const formatCues = (cues: Cues): string =>
  [
    "WEBVTT",
    "",
    ...cues.flatMap((cue) => [
      `${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}` +
      (cue.settings === "" ? "" : ` ${cue.settings}`),
      cue.text,
      ""
    ])
  ].join("\n")

/**
 * A WebVTT document and a list of cues are two encodings of one value, so they
 * are declared together: `decode` parses, `encode` renders, and the two cannot
 * drift out of step.
 */
export const Vtt = Schema.String.pipe(
  Schema.decodeTo(
    Cues,
    SchemaTransformation.transform({
      decode: (text: string) => parseCues(text),
      encode: (cues: Cues) => formatCues(cues)
    })
  )
)

// Effectful, not `*Sync`: the sync forms throw on a malformed document, which
// would turn a perfectly ordinary parse failure into a defect no caller can
// handle.
export const decode = Schema.decodeEffect(Vtt)
export const encode = Schema.encodeEffect(Vtt)

/**
 * Re-cut the track for a new start position: drop cues that have already ended
 * and rebase the rest to zero, matching the video, whose timestamps restart at
 * zero on every seek.
 */
export const cutFrom = (cues: Cues, offsetSeconds: number): Cues =>
  cues
    .filter((cue) => cue.end > offsetSeconds)
    .map((cue) => ({
      start: cue.start - offsetSeconds,
      end: cue.end - offsetSeconds,
      settings: cue.settings,
      text: cue.text
    }))
