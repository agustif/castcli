// The quality controller's interesting behaviour happens over minutes, which is
// exactly why it reads `Clock` and loops on a `Schedule` instead of calling
// Date.now() and setInterval. TestClock lets those minutes pass instantly.
//
// The case that matters most is the probe: an upshift restarts ffmpeg and so
// produces a fresh burst measurement that is, by construction, below the rung
// just moved to. An earlier version acted on that measurement and reversed
// every probe before it had played, so the stream oscillated forever.

import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Bitrate, Height, Rung } from "@castcli/domain"
import * as Ladder from "../src/Ladder.ts"
import * as Signals from "../src/Signals.ts"
import * as Quality from "../src/Controller.ts"

const rung = (height: number, bitrate: number) =>
  Rung.Encode({ height: Height.make(height), bitrate: Bitrate.make(bitrate) })

const LADDER = [rung(360, 800_000), rung(480, 1_200_000), rung(720, 2_500_000)]

const baseState = (overrides: Partial<Signals.State> = {}): Signals.State => ({
  index: 1,
  rung: LADDER[1] ?? rung(480, 1_200_000),
  capacity: 0,
  initialised: true,
  lastSwitchAt: 0,
  burstUntil: 0,
  burstPeak: 0,
  probingSince: Option.none(),
  buckets: [],
  stalls: [],
  penalties: new Map(),
  ...overrides
})

describe("Ladder", () => {
  it("never offers a rung above the source resolution", () => {
    const ladder = Ladder.build({
      sourceHeight: Height.make(480),
      sourceBitrate: Option.none(),
      canCopy: false
    })
    assert.isTrue(ladder.every((r) => r.height <= 480))
  })

  it("puts stream-copy at the top when the source can be copied", () => {
    const ladder = Ladder.build({
      sourceHeight: Height.make(1080),
      sourceBitrate: Option.some(Bitrate.make(20_000_000)),
      canCopy: true
    })
    assert.strictEqual(ladder.at(-1)?._tag, "Copy")
  })

  it("is strictly increasing in bitrate, so 'one rung up' is always better", () => {
    const ladder = Ladder.build({
      sourceHeight: Height.make(1080),
      sourceBitrate: Option.some(Bitrate.make(4_000_000)),
      canCopy: true
    })
    const bitrates = ladder.map((r) => r.bitrate)
    assert.deepStrictEqual(bitrates, [...bitrates].toSorted((a, b) => a - b))
    assert.strictEqual(new Set(bitrates).size, bitrates.length, "no duplicates")
  })
})

describe("Signals.phaseOf", () => {
  it("measures while inside the burst window", () => {
    const phase = Signals.phaseOf(baseState({ burstUntil: 10_000 }), 5_000)
    assert.strictEqual(phase._tag, "Measuring")
  })

  it("reports a stall ahead of a due probe", () => {
    // Both conditions hold; the stall must win, or we would probe upward on a
    // link that is already failing.
    const state = baseState({
      lastSwitchAt: 0,
      stalls: [Duration.toMillis(Signals.PROBE_AFTER)]
    })
    const phase = Signals.phaseOf(state, Duration.toMillis(Signals.PROBE_AFTER) + 1_000)
    assert.strictEqual(phase._tag, "Stalled")
  })

  it("accepts a probe that has played without stalling", () => {
    const at = Duration.toMillis(Signals.PROBE_HOLD) + 10_000
    const phase = Signals.phaseOf(baseState({ probingSince: Option.some(1), lastSwitchAt: 1 }), at)
    assert.strictEqual(phase._tag, "ProbeAccepted")
  })

  it("counts clustered stalls so repeated failures fall further", () => {
    const at = 100_000
    const state = baseState({ stalls: [at - 5_000, at - 1_000] })
    const phase = Signals.phaseOf(state, at)
    assert.strictEqual(phase._tag, "Stalled")
    assert.strictEqual(phase._tag === "Stalled" ? phase.clustered : 0, 2)
  })
})

// These use literal numbers rather than the constants they are pinning.
// Deriving the input from the constant — `Duration.toMillis(PENALTY) + 1` —
// reads naturally and asserts nothing: the test passes for any value the
// constant could take, including one ten times too large. The literals are the
// point, so a change to a threshold has to be a deliberate change here too.
describe("Signals.isPenalised", () => {
  it("holds a penalty inside its window", () => {
    const state = baseState({ penalties: new Map([[2, { at: 0, capacity: 1_000_000 }]]) })
    assert.isTrue(Signals.isPenalised(state, 2, 1_000))
  })

  it("expires a penalty after five minutes, and not before", () => {
    const state = baseState({ penalties: new Map([[2, { at: 0, capacity: 1_000_000 }]]) })

    // Five minutes: long enough that a rung which stalled is not retried into
    // the same congestion, short enough that one bad minute does not cap the
    // evening.
    assert.isTrue(Signals.isPenalised(state, 2, 4 * 60 * 1_000))
    assert.isFalse(Signals.isPenalised(state, 2, 5 * 60 * 1_000 + 1))
  })

  it("expires early once the link measurably recovers", () => {
    // Otherwise one brief dip caps quality for the whole penalty window. Half
    // as much again is the bar: enough to be a real recovery rather than
    // measurement noise.
    const recovered = baseState({
      capacity: 1_600_000,
      penalties: new Map([[2, { at: 0, capacity: 1_000_000 }]])
    })
    assert.isFalse(Signals.isPenalised(recovered, 2, 1_000))

    // Just below the bar it still holds, which is the half that fails if the
    // factor drifts.
    const marginal = baseState({
      capacity: 1_400_000,
      penalties: new Map([[2, { at: 0, capacity: 1_000_000 }]])
    })
    assert.isTrue(Signals.isPenalised(marginal, 2, 1_000))
  })
})

describe("Controller", () => {
  it.effect("does not reverse a probe on the burst reading it causes", () =>
    Effect.gen(function*() {
      const switches = yield* Ref.make<ReadonlyArray<string>>([])
      const controller = yield* Quality.make({
        ladder: LADDER,
        initialIndex: 0,
        onSwitch: (chosen) => Ref.update(switches, (all) => [...all, `${chosen.height}p`])
      })
      const fiber = yield* Effect.forkScoped(controller.run)

      // A link that carries the bottom rung and no more, measured once so the
      // ladder is sized and the controller settles there rather than climbing.
      yield* Effect.forEach(
        globalThis.Array.from({ length: 20 }, () => 0),
        () => Effect.andThen(controller.noteBytes(60_000), TestClock.adjust(Duration.seconds(1))),
        { discard: true }
      )
      yield* TestClock.adjust(Duration.seconds(20))
      const settled = yield* Ref.get(switches)

      // After a stable stretch the controller tries one rung higher. That is a
      // probe: an experiment, held until something refutes it.
      yield* TestClock.adjust(Signals.PROBE_AFTER)
      yield* TestClock.adjust(Duration.seconds(10))
      const probed = yield* Ref.get(switches)
      assert.isAbove(
        probed.length,
        settled.length,
        "the controller never probed, so the rule under test never applied"
      )

      // Now the part that used to break it. An upshift restarts ffmpeg, and the
      // burst that follows is measured while the encoder is still filling its
      // buffer — so it reads *below* the rung just moved to. Acting on that
      // reversed every probe before the rung had played a frame, and the stream
      // oscillated for as long as anyone watched.
      yield* controller.noteRestart
      yield* Effect.forEach(
        globalThis.Array.from({ length: 20 }, () => 0),
        () => Effect.andThen(controller.noteBytes(50_000), TestClock.adjust(Duration.seconds(1))),
        { discard: true }
      )
      yield* TestClock.adjust(Duration.seconds(20))

      const seen = yield* Ref.get(switches)
      assert.deepStrictEqual(
        seen.slice(probed.length),
        [],
        `a burst reading reversed the probe: ${seen.join(" -> ")}`
      )

      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.scoped))

  it.effect("treats a BUFFERING report as a stall", () =>
    Effect.gen(function*() {
      const switches = yield* Ref.make<ReadonlyArray<string>>([])
      const controller = yield* Quality.make({
        ladder: LADDER,
        initialIndex: 2,
        onSwitch: (r) => Ref.update(switches, (all) => [...all, `${r.height}p`])
      })
      const fiber = yield* Effect.forkScoped(controller.run)

      // Past the burst window and the settle window, then stall.
      yield* TestClock.adjust(Duration.seconds(35))
      yield* controller.noteState("BUFFERING")
      yield* TestClock.adjust(Duration.seconds(6))

      const seen = yield* Ref.get(switches)
      assert.isTrue(seen.length > 0, "a stall must cause a downshift")
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.scoped))
})
