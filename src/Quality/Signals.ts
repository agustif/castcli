// The controller's state, and the phase it implies.
//
// Deciding *what situation we are in* is separated from *what to do about it*.
// The phase is a tagged union computed from state and the clock, so the acting
// half is one exhaustive match with no conditional statements — and adding a
// new situation is a compile error until it is handled.

import { Data, Duration } from "effect"
import type { Rung } from "../Domain/Rung.ts"

// Durations rather than bare millisecond numbers: the unit is part of the type,
// so a window can never be compared against a count or passed where a byte size
// belongs, and `Duration.toMillis` marks every place we drop to raw arithmetic.
/** How long after a (re)start the drain rate still reflects real link capacity. */
export const BURST = Duration.seconds(14)
/** Grace after a switch, before its result is judged. */
const SETTLE = Duration.seconds(15)
/** Each switch costs a visible reload, so probing must be rare enough to be worth it. */
export const PROBE_AFTER = Duration.minutes(4)
/** Baseline blacklist duration for a rung that stalled. */
export const PENALTY = Duration.minutes(5)
/** Recency window for "did it just stall". */
const STALL_WINDOW = Duration.seconds(12)
/** Repeated stalls inside this window mean fall harder. */
const STALL_CLUSTER = Duration.seconds(45)
/** A probe surviving this long without a stall is accepted. */
export const PROBE_HOLD = Duration.minutes(1)
/** Continuous buffering is collapsed into one stall event within this window. */
export const STALL_DEBOUNCE = Duration.seconds(5)

const ms = Duration.toMillis
/** Capacity growth that expires a penalty early. */
export const RECOVERY_FACTOR = 1.5
/** Fraction of measured capacity we are willing to spend. */
export const SAFETY = 0.6

export interface Bucket {
  readonly second: number
  readonly bytes: number
}

interface Penalty {
  readonly at: number
  readonly capacity: number
}

export interface State {
  readonly index: number
  /** Best estimate of link capacity in bits per second, 0 until first measured. */
  readonly capacity: number
  readonly initialised: boolean
  readonly lastSwitchAt: number
  readonly burstUntil: number
  readonly burstPeak: number
  /** When a deliberate probe upward began; 0 when not probing. */
  readonly probingSince: number
  readonly buckets: ReadonlyArray<Bucket>
  readonly stalls: ReadonlyArray<number>
  readonly penalties: ReadonlyMap<number, Penalty>
}

/** What the controller should be doing right now. */
export type Phase = Data.TaggedEnum<{
  /** Inside a startup burst: the drain rate is the link's real capacity. */
  readonly Measuring: {}
  /** A burst just ended and produced a fresh capacity reading. */
  readonly Measured: { readonly capacity: number }
  /** A probe has played long enough without stalling to be believed. */
  readonly ProbeAccepted: {}
  /** Too soon after a switch to judge its result. */
  readonly Settling: {}
  /** The receiver reported buffering recently. */
  readonly Stalled: { readonly clustered: number }
  /** Stable for long enough to try one rung higher. */
  readonly ReadyToProbe: {}
  /** Nothing to do. */
  readonly Steady: {}
}>

export const Phase = Data.taggedEnum<Phase>()

/** Delivered bits per second over the trailing window. */
export const rateBps = (
  buckets: ReadonlyArray<Bucket>,
  nowSeconds: number,
  windowSeconds: number
): number => {
  const recent = buckets.filter((bucket) => bucket.second >= nowSeconds - windowSeconds)
  return recent.length < 2
    ? 0
    : (recent.reduce((sum, bucket) => sum + bucket.bytes, 0) * 8) / recent.length
}

const stallsSince = (state: State, at: number, window: number): number =>
  state.stalls.filter((stall) => stall >= at - window).length

/**
 * A penalty lifts on a timer, or early once the link measurably recovers —
 * otherwise one brief dip would cap quality for the next five minutes.
 */
export const isPenalised = (state: State, index: number, at: number): boolean => {
  const penalty = state.penalties.get(index)
  return penalty !== undefined &&
    at - penalty.at <= ms(PENALTY) &&
    !(penalty.capacity > 0 && state.capacity > penalty.capacity * RECOVERY_FACTOR)
}

/** Highest rung that fits the capacity estimate and is not penalised. */
export const bestFor = (
  state: State,
  ladder: ReadonlyArray<Rung>,
  capacity: number,
  at: number
): number =>
  ladder.reduce(
    (best, rung, index) =>
      rung.bitrate <= capacity * SAFETY && !isPenalised(state, index, at) ? index : best,
    0
  )

/**
 * Classify the current situation. Ordering matters: measurement beats
 * everything, a stall beats a probe, and probing beats idling.
 */
export const phaseOf = (state: State, at: number): Phase =>
  at < state.burstUntil
    ? Phase.Measuring()
    : state.burstPeak > 0
    ? Phase.Measured({
      capacity: state.capacity === 0
        // Blend, so a single optimistic burst cannot dominate the estimate.
        ? state.burstPeak
        : state.capacity * 0.4 + state.burstPeak * 0.6
    })
    : state.probingSince > 0 && at - state.probingSince > ms(PROBE_HOLD)
    ? Phase.ProbeAccepted()
    : at - state.lastSwitchAt < ms(SETTLE)
    ? Phase.Settling()
    : stallsSince(state, at, ms(STALL_WINDOW)) > 0
    ? Phase.Stalled({ clustered: stallsSince(state, at, ms(STALL_CLUSTER)) })
    : at - state.lastSwitchAt > ms(PROBE_AFTER)
    ? Phase.ReadyToProbe()
    : Phase.Steady()
