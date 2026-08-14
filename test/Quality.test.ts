// The quality controller's interesting behaviour happens over minutes, which is
// exactly why it reads `Clock` and loops on a `Schedule` instead of calling
// Date.now() and setInterval. TestClock lets those minutes pass instantly.
//
// The case that matters most is the probe: an upshift restarts ffmpeg and so
// produces a fresh burst measurement that is, by construction, below the rung
// just moved to. An earlier version acted on that measurement and reversed
// every probe before it had played, so the stream oscillated forever.

import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import * as Brands from "../src/Domain/Brands.ts"
import { Rung } from "../src/Domain/Rung.ts"
import * as Ladder from "../src/Quality/Ladder.ts"
import * as Signals from "../src/Quality/Signals.ts"
import * as Quality from "../src/Quality/Controller.ts"

const rung = (height: number, bitrate: number) =>
  Rung.Encode({ height: Brands.height(height), bitrate: Brands.bitrate(bitrate) })

const LADDER = [rung(360, 800_000), rung(480, 1_200_000), rung(720, 2_500_000)]

const baseState = (overrides: Partial<Signals.State> = {}): Signals.State => ({
  index: 1,
  capacity: 0,
  initialised: true,
  lastSwitchAt: 0,
  burstUntil: 0,
  burstPeak: 0,
  probingSince: 0,
  buckets: [],
  stalls: [],
  penalties: new Map(),
  ...overrides
})

describe("Ladder", () => {
  it("never offers a rung above the source resolution", () => {
    const ladder = Ladder.build({ sourceHeight: 480, sourceBitrate: null, canCopy: false })
    assert.isTrue(ladder.every((r) => r.height <= 480))
  })

  it("puts stream-copy at the top when the source can be copied", () => {
    const ladder = Ladder.build({
      sourceHeight: 1080,
      sourceBitrate: 20_000_000,
      canCopy: true
    })
    assert.strictEqual(ladder.at(-1)?._tag, "Copy")
  })

  it("is strictly increasing in bitrate, so 'one rung up' is always better", () => {
    const ladder = Ladder.build({ sourceHeight: 1080, sourceBitrate: 4_000_000, canCopy: true })
    ladder.forEach((r, i) => {
      assert.isTrue(i === 0 || r.bitrate > ladder[i - 1]!.bitrate)
    })
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
    const phase = Signals.phaseOf(baseState({ probingSince: 1, lastSwitchAt: 1 }), at)
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

describe("Signals.isPenalised", () => {
  it("holds a penalty inside its window", () => {
    const state = baseState({ penalties: new Map([[2, { at: 0, capacity: 1_000_000 }]]) })
    assert.isTrue(Signals.isPenalised(state, 2, 1_000))
  })

  it("expires a penalty on the timer", () => {
    const state = baseState({ penalties: new Map([[2, { at: 0, capacity: 1_000_000 }]]) })
    assert.isFalse(Signals.isPenalised(state, 2, Duration.toMillis(Signals.PENALTY) + 1))
  })

  it("expires early once the link measurably recovers", () => {
    // Otherwise one brief dip caps quality for the whole penalty window.
    const state = baseState({
      capacity: 1_000_000 * Signals.RECOVERY_FACTOR + 1,
      penalties: new Map([[2, { at: 0, capacity: 1_000_000 }]])
    })
    assert.isFalse(Signals.isPenalised(state, 2, 1_000))
  })
})

describe("Controller", () => {
  it.effect("does not reverse a probe on the burst reading it causes", () =>
    Effect.gen(function*() {
      const switches = yield* Ref.make<ReadonlyArray<string>>([])
      const controller = yield* Quality.make({
        ladder: LADDER,
        initialIndex: 0,
        onSwitch: (r) => Ref.update(switches, (all) => [...all, `${r.height}p`])
      })
      const fiber = yield* Effect.forkScoped(controller.run)

      // Deliver bytes at a rate that comfortably supports the bottom rung, then
      // let enough time pass for a measurement and a probe.
      yield* controller.noteBytes(400_000)
      yield* TestClock.adjust(Duration.seconds(20))
      yield* TestClock.adjust(Signals.PROBE_AFTER)
      yield* TestClock.adjust(Duration.seconds(30))

      const seen = yield* Ref.get(switches)
      // Whatever it chose, it must not have bounced straight back down to the
      // rung it started on without a stall ever being reported.
      const bounced = seen.length >= 2 && seen[0] === seen[1]
      assert.isFalse(bounced, `oscillated: ${seen.join(" -> ")}`)
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
