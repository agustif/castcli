// Adaptive quality control.
//
// The hard part is that you cannot directly measure spare bandwidth. Once the
// stream is in steady state the delivery rate equals the encoded bitrate, so a
// throughput reading tells you only that the current rung fits — never whether
// a higher one would. Three signals get us around that:
//
//   1. Startup bursts. ffmpeg encodes far faster than realtime until the socket
//      backs up, so for the first seconds after any (re)start the drain rate is
//      the link's actual capacity. Every rung change restarts ffmpeg, so each
//      switch hands us a fresh capacity reading for free.
//
//   2. Stalls. The receiver reporting BUFFERING is unambiguous evidence that
//      the current rung does not fit.
//
//   3. Probing. After a stable stretch we try one rung higher and watch.
//
// Because network conditions change, nothing here is permanent: a rung that
// stalled is penalised, but the penalty expires on a timer *and* early if a
// later capacity measurement shows the link has genuinely improved.

const BURST_MS = 14_000 // window after a (re)start treated as a capacity probe
const SETTLE_MS = 15_000 // grace after a switch, before its result is judged
// Each switch costs a visible reload, so probing has to be rare enough that the
// interruption is worth the quality it buys.
const PROBE_AFTER_MS = 240_000 // stable time required before trying a higher rung
const PENALTY_MS = 300_000 // baseline blacklist duration for a rung that stalled
const STALL_WINDOW_MS = 12_000 // recency window for "did it just stall"
const STALL_CLUSTER_MS = 45_000 // repeated stalls inside this window mean fall harder
const PROBE_HOLD_MS = 60_000 // a probe surviving this long without a stall is accepted
const RECOVERY_FACTOR = 1.5 // capacity growth that expires a penalty early
const SAFETY = 0.6 // fraction of measured capacity we are willing to spend

export function buildLadder({ sourceHeight, sourceBitrate, canCopy }) {
  const rungs = [
    { height: 360, bitrate: 800_000 },
    { height: 480, bitrate: 1_200_000 },
    { height: 540, bitrate: 1_800_000 },
    { height: 720, bitrate: 2_500_000 },
    { height: 720, bitrate: 4_000_000 },
    { height: 1080, bitrate: 6_000_000 },
  ].filter((r) => r.height <= sourceHeight)

  if (canCopy && sourceBitrate) {
    rungs.push({ height: sourceHeight, bitrate: sourceBitrate, copy: true })
  }
  return rungs
    .sort((a, b) => a.bitrate - b.bitrate)
    .filter((r, i, all) => i === 0 || r.bitrate > all[i - 1].bitrate)
}

export function describeRung(rung) {
  if (!rung) return 'unknown'
  if (rung.copy) return `${rung.height}p original (stream copy)`
  return `${rung.height}p @ ${(rung.bitrate / 1_000_000).toFixed(1)} Mbps`
}

export class QualityController {
  #buckets = [] // per-second delivered byte counts
  #burstUntil = 0
  #burstPeak = 0
  #capacity = 0 // best current estimate of link capacity, bits/sec
  #lastSwitchAt = 0
  #stalls = [] // timestamps of recent BUFFERING reports
  #penalties = new Map() // rung index -> { at, capacity }
  #initialised = false // has the first capacity measurement been applied
  #probingSince = 0 // when a deliberate probe upward started, 0 if not probing
  #timer = null

  constructor({ ladder, index, onSwitch, log }) {
    this.ladder = ladder
    this.index = index
    this.onSwitch = onSwitch
    this.log = log ?? (() => {})
  }

  get rung() {
    return this.ladder[this.index]
  }

  get capacityBps() {
    return this.#capacity
  }

  start() {
    const now = Date.now()
    this.#lastSwitchAt = now
    this.#burstUntil = now + BURST_MS
    this.#timer = setInterval(() => this.#tick(), 2000)
  }

  stop() {
    clearInterval(this.#timer)
  }

  noteBytes(n) {
    const second = Math.floor(Date.now() / 1000)
    const last = this.#buckets.at(-1)
    if (last && last.t === second) last.bytes += n
    else this.#buckets.push({ t: second, bytes: n })
    if (this.#buckets.length > 120) this.#buckets.shift()
  }

  noteState(playerState) {
    if (playerState === 'BUFFERING') {
      const now = Date.now()
      // Collapse a continuous stall into one event rather than many.
      if (now - (this.#stalls.at(-1) ?? 0) > 5000) this.#stalls.push(now)
    }
  }

  /** Any restart (seek or rung change) gives us a fresh burst to measure. */
  noteRestart() {
    const now = Date.now()
    this.#buckets = []
    this.#lastSwitchAt = now
    this.#burstUntil = now + BURST_MS
    this.#burstPeak = 0
  }

  #rateBps(seconds) {
    const cutoff = Math.floor(Date.now() / 1000) - seconds
    const recent = this.#buckets.filter((b) => b.t >= cutoff)
    if (recent.length < 2) return 0
    const bytes = recent.reduce((sum, b) => sum + b.bytes, 0)
    return (bytes * 8) / recent.length
  }

  #stallsSince(ms) {
    const cutoff = Date.now() - ms
    return this.#stalls.filter((t) => t >= cutoff).length
  }

  /**
   * A penalty lifts on a timer, or early once the link measurably recovers —
   * otherwise a brief dip would cap quality for the next five minutes.
   */
  #isPenalised(index) {
    const penalty = this.#penalties.get(index)
    if (!penalty) return false
    const now = Date.now()
    if (now - penalty.at > PENALTY_MS) {
      this.#penalties.delete(index)
      return false
    }
    if (penalty.capacity && this.#capacity > penalty.capacity * RECOVERY_FACTOR) {
      this.#penalties.delete(index)
      this.log(`quality: link recovered (~${(this.#capacity / 1e6).toFixed(1)} Mbps), retrying ${describeRung(this.ladder[index])}`)
      return false
    }
    return true
  }

  /** Highest rung whose bitrate fits the capacity estimate and isn't penalised. */
  #bestFor(capacity) {
    const budget = capacity * SAFETY
    let best = 0
    for (let i = 0; i < this.ladder.length; i++) {
      if (this.ladder[i].bitrate <= budget && !this.#isPenalised(i)) best = i
    }
    return best
  }

  #switchTo(index, reason) {
    if (index === this.index || !this.ladder[index]) return
    const from = this.rung
    this.index = index
    this.log(`quality: ${describeRung(from)} -> ${describeRung(this.rung)} (${reason})`)
    this.onSwitch(this.rung) // the caller restarts the stream, which calls noteRestart()
  }

  #tick() {
    const now = Date.now()

    // Phase 1: measure capacity from the current burst.
    if (now < this.#burstUntil) {
      this.#burstPeak = Math.max(this.#burstPeak, this.#rateBps(4))
      return
    }
    if (this.#burstPeak > 0) {
      // Blend so one optimistic burst cannot dominate the estimate.
      this.#capacity = this.#capacity
        ? this.#capacity * 0.4 + this.#burstPeak * 0.6
        : this.#burstPeak
      this.#burstPeak = 0
      const target = this.#bestFor(this.#capacity)

      // A probe is an experiment, and only a stall refutes it. Every upshift
      // restarts ffmpeg and so produces a fresh burst reading; because that
      // reading is always below the rung we just moved to, letting it act would
      // reverse the probe before the rung was ever given a chance to play.
      const probing = this.#probingSince > 0
      // The very first measurement sizes the ladder. After that a burst reading
      // may only pull quality *down* — upshifts are left to the slow probe.
      const mayAct = !this.#initialised || (target < this.index && !probing)
      this.#initialised = true
      if (mayAct && target !== this.index) {
        this.#switchTo(target, `measured ~${(this.#capacity / 1e6).toFixed(1)} Mbps`)
        return
      }
    }

    // A probe that has played for a while without stalling is accepted, and the
    // rung it reached becomes evidence that the link can carry that bitrate.
    if (this.#probingSince > 0 && now - this.#probingSince > PROBE_HOLD_MS) {
      this.#probingSince = 0
      this.#capacity = Math.max(this.#capacity, this.rung.bitrate / SAFETY)
      this.log(`quality: ${describeRung(this.rung)} accepted (no stalls)`)
    }

    if (now - this.#lastSwitchAt < SETTLE_MS) return

    // Phase 2: recent stall. Repeated stalls mean the link moved a long way, so
    // fall further in one go rather than grinding down a rung at a time.
    if (this.#stallsSince(STALL_WINDOW_MS) > 0) {
      const clustered = this.#stallsSince(STALL_CLUSTER_MS)
      const drop = clustered >= 2 ? 2 : 1
      this.#probingSince = 0
      this.#penalties.set(this.index, { at: now, capacity: this.#capacity })
      // A stall is also evidence about capacity: we clearly cannot afford this.
      this.#capacity = Math.min(this.#capacity || Infinity, this.rung.bitrate * 0.9)
      const target = Math.max(0, this.index - drop)
      if (target !== this.index) {
        this.#switchTo(target, clustered >= 2 ? 'repeated stalls' : 'receiver was buffering')
      }
      return
    }

    // Phase 3: stable for a while. Probe one rung higher.
    if (now - this.#lastSwitchAt > PROBE_AFTER_MS) {
      const next = this.index + 1
      if (!this.ladder[next] || this.#isPenalised(next)) return
      this.#probingSince = now
      this.#switchTo(next, 'stable, probing higher')
    }
  }
}
