// Adaptive quality control.
//
// You cannot measure spare bandwidth directly. Once a stream is in steady state
// the delivery rate equals the encoded bitrate, so throughput tells you only
// that the current rung fits — never whether a higher one would. Three signals
// get around that:
//
//   1. Startup bursts. ffmpeg encodes far faster than realtime until the socket
//      backs up, so just after any (re)start the drain rate is the link's real
//      capacity. Every rung change restarts ffmpeg, so each switch yields a
//      fresh measurement for free.
//   2. Stalls. The receiver reporting BUFFERING is unambiguous evidence that
//      the current rung does not fit.
//   3. Probing. After a stable stretch, try one rung higher and watch.
//
// A probe is an experiment and only a stall refutes it. That matters because
// every upshift restarts ffmpeg and so produces a new burst reading which is,
// by construction, below the rung just moved to — acting on it reversed the
// probe before that rung was ever given a chance, and the stream oscillated
// indefinitely. A probe that plays without stalling is accepted instead, and
// its bitrate becomes evidence about capacity.
//
// State lives in a `Ref` and the loop is `Effect.repeat` on a `Schedule`, so
// the controller is testable with `TestClock` rather than real time. Deciding
// *what situation we are in* lives in Signals.ts; this module only acts, as one
// exhaustive match.

import { Array, Clock, Duration, Effect, Match, Option, Ref, Schedule } from "effect"
import { describeRung, EmptyLadderError, type Rung } from "@castcli/domain"
import { Namespace } from "@castcli/protocol"

type PlayerState = Namespace.PlayerState
import * as Signals from "./Signals.ts"

export const make = Effect.fn("Quality.make")(function*(options: {
  readonly ladder: ReadonlyArray<Rung>
  readonly initialIndex: number
  readonly onSwitch: (rung: Rung) => Effect.Effect<void>
}) {
  const { initialIndex, ladder, onSwitch } = options
  const now = yield* Clock.currentTimeMillis
  const initialRung = yield* Option.match(Array.get(ladder, initialIndex), {
    onNone: () => Effect.fail(new EmptyLadderError()),
    onSome: (rung) => Effect.succeed(rung)
  })

  const state = yield* Ref.make<Signals.State>({
    index: initialIndex,
    rung: initialRung,
    capacity: 0,
    initialised: false,
    lastSwitchAt: now,
    burstUntil: now + Duration.toMillis(Signals.BURST),
    burstPeak: 0,
    probingSince: 0,
    buckets: [],
    stalls: [],
    penalties: new Map()
  })

  const switchTo = Effect.fn("Quality.switchTo")(function*(index: number, reason: string) {
    const current = yield* Ref.get(state)
    // Off either end of the ladder there is nothing to switch to, which is an
    // ordinary outcome rather than an error.
    yield* Option.match(Array.get(ladder, index), {
      onNone: () => Effect.void,
      onSome: (rung) =>
        Effect.when(
          Effect.gen(function*() {
            yield* Ref.set(state, { ...current, index, rung })
            yield* Effect.logInfo(
              `quality: ${describeRung(current.rung)} -> ${describeRung(rung)} (${reason})`
            )
            // The caller restarts the stream, which calls noteRestart().
            yield* onSwitch(rung)
          }),
          Effect.succeed(index !== current.index)
        )
    })
  })

  const onMeasuring = Effect.fn("Quality.onMeasuring")(function*(at: number) {
    const current = yield* Ref.get(state)
    const peak = Math.max(
      current.burstPeak,
      Signals.rateBps(current.buckets, Math.floor(at / 1000), 4)
    )
    yield* Ref.set(state, { ...current, burstPeak: peak })
  })

  const onMeasured = Effect.fn("Quality.onMeasured")(function*(at: number, capacity: number) {
    const current = yield* Ref.get(state)
    const measured: Signals.State = { ...current, capacity, burstPeak: 0, initialised: true }
    yield* Ref.set(state, measured)

    const target = Signals.bestFor(measured, ladder, capacity, at)
    // The first measurement sizes the ladder. After that a burst reading may
    // only pull quality *down*, and never while a probe is in flight.
    const mayAct = !current.initialised ||
      (target < current.index && current.probingSince === 0)
    yield* Effect.when(
      switchTo(target, `measured ~${(capacity / 1e6).toFixed(1)} Mbps`),
      Effect.succeed(mayAct)
    )
  })

  const onProbeAccepted = Effect.fn("Quality.onProbeAccepted")(function*() {
    const current = yield* Ref.get(state)
    const rung = current.rung
    yield* Ref.set(state, {
      ...current,
      probingSince: 0,
      // It played without stalling, so the link demonstrably carries this much.
      capacity: Math.max(current.capacity, rung.bitrate / Signals.SAFETY)
    })
    yield* Effect.logInfo(`quality: ${describeRung(rung)} accepted (no stalls)`)
  })

  const onStalled = Effect.fn("Quality.onStalled")(function*(at: number, clustered: number) {
    const current = yield* Ref.get(state)
    const rung = current.rung
    const penalties = new Map(current.penalties)
    penalties.set(current.index, { at, capacity: current.capacity })
    yield* Ref.set(state, {
      ...current,
      penalties,
      probingSince: 0,
      // A stall is evidence too: this rung clearly does not fit.
      capacity: Math.min(
        current.capacity === 0 ? Number.POSITIVE_INFINITY : current.capacity,
        rung.bitrate * 0.9
      )
    })
    // Repeated stalls mean the link moved a long way, so fall further at once
    // rather than grinding down one rung at a time.
    yield* switchTo(
      Math.max(0, current.index - (clustered >= 2 ? 2 : 1)),
      clustered >= 2 ? "repeated stalls" : "receiver was buffering"
    )
  })

  const onReadyToProbe = Effect.fn("Quality.onReadyToProbe")(function*(at: number) {
    const current = yield* Ref.get(state)
    const next = current.index + 1
    yield* Effect.when(
      Effect.andThen(
        Ref.set(state, { ...current, probingSince: at }),
        switchTo(next, "stable, probing higher")
      ),
      Effect.succeed(Option.isSome(Array.get(ladder, next)) && !Signals.isPenalised(current, next, at))
    )
  })

  const tick = Effect.gen(function*() {
    const at = yield* Clock.currentTimeMillis
    const current = yield* Ref.get(state)
    return yield* Match.value(Signals.phaseOf(current, at)).pipe(
      Match.tag("Measuring", () => onMeasuring(at)),
      Match.tag("Measured", ({ capacity }) => onMeasured(at, capacity)),
      Match.tag("ProbeAccepted", () => onProbeAccepted()),
      Match.tag("Settling", () => Effect.void),
      Match.tag("Stalled", ({ clustered }) => onStalled(at, clustered)),
      Match.tag("ReadyToProbe", () => onReadyToProbe(at)),
      Match.tag("Steady", () => Effect.void),
      Match.exhaustive
    )
  })

  return {
    /** Bytes the receiver actually accepted, honouring backpressure. */
    noteBytes: (count: number) =>
      Effect.gen(function*() {
        const at = yield* Clock.currentTimeMillis
        const second = Math.floor(at / 1000)
        yield* Ref.update(state, (current) => {
          const last = current.buckets.at(-1)
          const buckets = last !== undefined && last.second === second
            ? [...current.buckets.slice(0, -1), { second, bytes: last.bytes + count }]
            : [...current.buckets, { second, bytes: count }]
          return { ...current, buckets: buckets.slice(-120) }
        })
      }),

    /** The receiver's reported player state. */
    noteState: (playerState: PlayerState) =>
      Effect.when(
        Effect.gen(function*() {
          const at = yield* Clock.currentTimeMillis
          yield* Ref.update(state, (current) =>
            // Collapse a continuous stall into a single event.
            at - (current.stalls.at(-1) ?? 0) <= Duration.toMillis(Signals.STALL_DEBOUNCE)
              ? current
              : { ...current, stalls: [...current.stalls, at].slice(-20) })
        }),
        Effect.succeed(playerState === "BUFFERING")
      ),

    /** A seek or reload: rate history is meaningless, expect a fresh burst. */
    noteRestart: Effect.gen(function*() {
      const at = yield* Clock.currentTimeMillis
      yield* Ref.update(state, (current) => ({
        ...current,
        buckets: [],
        burstPeak: 0,
        burstUntil: at + Duration.toMillis(Signals.BURST),
        lastSwitchAt: at
      }))
    }),

    currentRung: Effect.map(Ref.get(state), (current) => current.rung),

    /** Runs the control loop until interrupted. Fork it. */
    run: Effect.repeat(tick, Schedule.spaced("2 seconds"))
  }
})

/** Inferred from `make` rather than restated, so the two cannot drift. */
export type Controller = Effect.Success<ReturnType<typeof make>>
