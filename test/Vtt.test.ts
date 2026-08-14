// The subtitle path had four separate silent failure modes in practice, so the
// round trip and the re-cut are worth pinning down.

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Vtt from "../src/Media/Vtt/Codec.ts"

const SAMPLE = `WEBVTT

00:00:35.268 --> 00:00:42.275
EL DÍA DE LA REVELACIÓN

00:00:47.822 --> 00:00:51.159
¡Uno, dos, tres!

00:01:00.000 --> 00:01:02.500
Two
lines
`

describe("Vtt codec", () => {
  it.effect("decodes cues, ignoring the header block", () =>
    Effect.gen(function*() {
      const cues = yield* Vtt.decode(SAMPLE)
      assert.strictEqual(cues.length, 3)
      assert.strictEqual(cues[0]?.start, 35.268)
      assert.strictEqual(cues[0]?.end, 42.275)
      assert.strictEqual(cues[0]?.text, "EL DÍA DE LA REVELACIÓN")
    }))

  it.effect("keeps multi-line cue text intact", () =>
    Effect.gen(function*() {
      const cues = yield* Vtt.decode(SAMPLE)
      assert.strictEqual(cues[2]?.text, "Two\nlines")
    }))

  it.effect("round-trips through encode without losing cues", () =>
    Effect.gen(function*() {
      const cues = yield* Vtt.decode(SAMPLE)
      const text = yield* Vtt.encode(cues)
      const again = yield* Vtt.decode(text)
      assert.deepStrictEqual(again, cues)
    }))

  it.effect("always emits a WEBVTT header, which receivers require", () =>
    Effect.gen(function*() {
      const text = yield* Vtt.encode([])
      assert.isTrue(text.startsWith("WEBVTT"))
    }))

  it.effect("re-cuts to an offset, matching video timestamps rebased to zero", () =>
    Effect.gen(function*() {
      const cues = yield* Vtt.decode(SAMPLE)
      const cut = Vtt.cutFrom(cues, 45)
      // The first cue has already ended by 45s and must be dropped, or the
      // track drifts by exactly the seek amount.
      assert.strictEqual(cut.length, 2)
      assert.strictEqual(cut[0]?.start, 47.822 - 45)
    }))

  it.effect("keeps a cue that is still on screen at the cut point", () =>
    Effect.gen(function*() {
      const cues = yield* Vtt.decode(SAMPLE)
      const cut = Vtt.cutFrom(cues, 40)
      assert.strictEqual(cut.length, 3)
      // Its start goes negative, which is correct: it is already showing.
      assert.isTrue((cut[0]?.start ?? 0) < 0)
    }))
})
