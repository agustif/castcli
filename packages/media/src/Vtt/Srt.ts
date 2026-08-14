// SubRip, for televisions that will not read WebVTT.
//
// The same cues as `Vtt`, written the other way round. This exists because of a
// specific silent failure: the DIDL-Lite metadata handed to a DLNA renderer
// advertises its subtitle track as `text/srt`, and Samsung and LG sets read the
// `sec:CaptionInfoEx` element expecting exactly that. Serving WebVTT at that URL
// produces a file the set fetches, fails to parse, and says nothing about — the
// subtitles simply never appear.
//
// The two formats are close enough that the difference is easy to miss and
// fatal anyway: SubRip numbers its cues, separates the timestamp fields with a
// comma rather than a full stop, and has no `WEBVTT` header. A parser written
// for one rejects the other on the first line.

import { Array } from "effect"
import type { Cue, Cues } from "./Codec.ts"

/**
 * `HH:MM:SS,mmm` — zero-padded hours, and a comma before the milliseconds.
 *
 * Both details are load bearing. WebVTT allows the hours to be omitted and uses
 * a full stop; SubRip requires the hours and the comma, and players that accept
 * one form reject the other rather than guessing.
 */
const timestamp = (seconds: number): string => {
  const whole = Math.max(0, seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor(whole / 60) % 60
  const remaining = Math.floor(whole) % 60
  const millis = Math.round((whole - Math.floor(whole)) * 1000)

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${
    String(remaining).padStart(2, "0")
  },${String(millis).padStart(3, "0")}`
}

/**
 * Write cues as SubRip.
 *
 * Cues are numbered from one. The numbering is not decoration: some players
 * index by it and a track numbered from zero, or with gaps, confuses them.
 */
export const encode = (cues: Cues): string =>
  Array.map(
    cues,
    (cue: Cue, index: number) =>
      `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}\n`
  ).join("\n")
