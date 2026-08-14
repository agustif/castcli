// Track selection, tested against the file this tool was built for.
//
// The case that matters is the one the container gets wrong: two Spanish
// subtitle tracks, the 24-cue forced-signage one flagged `default` and the
// 1670-line dialogue one flagged nothing. Any heuristic that trusts the flags
// picks the signage. These tests pin that it does not.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { FilePath, MediaStream } from "@castcli/domain"
import { Ffmpeg } from "../src/Ffmpeg/Service.ts"
import { chooseAudio, chooseSubtitle } from "../src/Tracks/Select.ts"
import type * as Vtt from "../src/Vtt/Codec.ts"

const stream = (
  index: number,
  codecType: string,
  language: Option.Option<string>,
  options: { readonly isDefault?: boolean } = {}
) =>
  new MediaStream({
    index,
    codec_type: codecType,
    codec_name: codecType === "audio" ? "ac3" : "subrip",
    ...(options.isDefault === true ? { disposition: { default: 1 } } : {}),
    ...Option.match(language, {
      onNone: () => ({}),
      onSome: (value) => ({ tags: { language: value } })
    })
  })

const audio = (index: number, language: string, options?: { readonly isDefault?: boolean }) =>
  stream(index, "audio", Option.some(language), options)

const subtitle = (index: number, language: string, options?: { readonly isDefault?: boolean }) =>
  stream(index, "subtitle", Option.some(language), options)

/** The real release: Spanish E-AC-3, Spanish AC-3, English AC-3. */
const AUDIO_TRACKS = [audio(1, "spa", { isDefault: true }), audio(2, "spa"), audio(3, "eng")]

/** Stream 4 is forced signage and flagged default; stream 5 is the dialogue. */
const SUBTITLE_TRACKS = [subtitle(4, "spa", { isDefault: true }), subtitle(5, "spa"), subtitle(6, "eng")]

/**
 * An ffmpeg that only knows how many cues each track has. The counts are the
 * real ones measured from the file.
 */
const cuesOf = (count: number): Vtt.Cues =>
  globalThis.Array.from(
    { length: count },
    (_, cue): Vtt.Cue => ({ start: cue, end: cue + 1, settings: "", text: `cue ${cue}` })
  )

const fakeFfmpeg = (counts: Record<number, number>) =>
  Layer.succeed(Ffmpeg, {
    probe: () => Effect.die("probe is not used by these tests"),
    transcode: () => Effect.die("transcode is not used by these tests"),
    segment: () => Effect.die("segment is not used by these tests"),
    extractCues: (_file, index) => Effect.succeed(cuesOf(counts[index] ?? 0))
  })

const FILE = FilePath.make("/movies/disclosure-day.mkv")

describe("chooseAudio", () => {
  it("prefers the first language in the list, not the container's default", () => {
    // The Spanish track is flagged default; an English preference must still
    // win, which is the whole point of asking.
    assert.deepStrictEqual(
      Option.map(chooseAudio(AUDIO_TRACKS, ["eng"]), (found) => found.index),
      Option.some(3)
    )
  })

  it("respects the order of the preference list", () => {
    assert.deepStrictEqual(
      Option.map(chooseAudio(AUDIO_TRACKS, ["spa", "eng"]), (found) => found.index),
      Option.some(1)
    )
  })

  it("falls back to the container's default when no language matches", () => {
    // Falling back rather than failing: a file whose tracks are all tagged in
    // a language nobody asked for should still play with sound.
    assert.deepStrictEqual(
      Option.map(chooseAudio(AUDIO_TRACKS, ["fra"]), (found) => found.index),
      Option.some(1)
    )
  })

  it("treats an untagged track as `und`, which is how Matroska writes English", () => {
    const untagged = [stream(1, "audio", Option.none())]
    assert.deepStrictEqual(
      Option.map(chooseAudio(untagged, ["und"]), (found) => found.index),
      Option.some(1)
    )
  })

  it("has nothing to choose in a file with no audio", () => {
    assert.isTrue(Option.isNone(chooseAudio([], ["eng"])))
  })
})

describe("chooseSubtitle", () => {
  it.effect("picks the track with the most cues, not the one flagged default", () =>
    Effect.gen(function*() {
      const choice = yield* chooseSubtitle(FILE, SUBTITLE_TRACKS, ["spa"])
      assert.deepStrictEqual(
        Option.map(choice, (found) => found.stream.index),
        Option.some(5)
      )
      assert.deepStrictEqual(
        Option.map(choice, (found) => found.cues.length),
        Option.some(1670)
      )
    }).pipe(Effect.provide(fakeFfmpeg({ 4: 24, 5: 1670, 6: 1655 }))))

  it.effect("reports the runner-up so the choice can be second-guessed", () =>
    Effect.gen(function*() {
      const choice = yield* chooseSubtitle(FILE, SUBTITLE_TRACKS, ["spa"])
      assert.deepStrictEqual(
        Option.map(choice, (found) => found.considered.map((c) => [c.stream.index, c.cueCount])),
        Option.some([[5, 1670], [4, 24]])
      )
    }).pipe(Effect.provide(fakeFfmpeg({ 4: 24, 5: 1670, 6: 1655 }))))

  it.effect("only reads candidates in the winning language", () =>
    Effect.gen(function*() {
      // The English track must not be extracted when Spanish was asked for:
      // a release with eight subtitle tracks would otherwise cost eight passes
      // over a multi-gigabyte container to answer a question about two.
      const choice = yield* chooseSubtitle(FILE, SUBTITLE_TRACKS, ["spa"])
      assert.deepStrictEqual(
        Option.map(choice, (found) => found.considered.length),
        Option.some(2)
      )
    }).pipe(Effect.provide(fakeFfmpeg({ 4: 24, 5: 1670, 6: 1655 }))))

  it.effect("chooses nothing when no track matches the preference", () =>
    Effect.gen(function*() {
      // Silence rather than surprise: subtitles in a language you did not ask
      // for are worse than none.
      const choice = yield* chooseSubtitle(FILE, SUBTITLE_TRACKS, ["fra"])
      assert.isTrue(Option.isNone(choice))
    }).pipe(Effect.provide(fakeFfmpeg({}))))
})
