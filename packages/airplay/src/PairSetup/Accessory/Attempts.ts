/**
 * The counter that stops a setup code being guessed.
 *
 * A HomeKit setup code is eight decimal digits — a million possibilities, minus
 * the handful the specification forbids — and SRP does not slow a guess down.
 * Each wrong attempt is one full exchange, and an exchange is arithmetic and two
 * round trips; nothing about it takes long enough to matter. Without a counter,
 * an accessory answering M3 as fast as it can is a code that falls in an
 * afternoon, and the exchange looks flawless the whole time.
 *
 * `Srp/Server.ts` says explicitly that it does not do this and that it belongs
 * in the state machine above, because SRP has no notion of an "attempt": only
 * the layer that knows a message is M3 knows that a rejected M1 was a person
 * mistyping. This is that layer.
 *
 * It is a counter of *consecutive* failures. A success resets it, which is what
 * makes 100 a usable number: someone who fumbles the code twice and gets it
 * right on the third go has spent nothing, while a program guessing gets exactly
 * that many tries in the accessory's lifetime.
 *
 * @since 0.1.0
 */
import { Effect, Ref } from "effect"

/**
 * How many consecutive wrong setup codes HomeKit tolerates.
 *
 * **Details**
 *
 * 100, from `HAPPairingPairSetupGetM2` in
 * `packages/airplay/vendor/HAPPairingPairSetup.c`, which refuses to start an
 * exchange once `numAuthAttempts >= 100` and answers
 * `kTLVType_Error = MaxTries`. The ADK keeps the count in its key-value store,
 * so it survives a reboot — a lockout an attacker can clear by power-cycling the
 * television is not a lockout.
 *
 * **Gotchas**
 *
 * The refusal is permanent, not a delay. HAP has a separate
 * `kTLVType_Error = Backoff` with a `kTLVType_RetryDelay` for "come back later";
 * `MaxTries` means the accessory will not pair again until it is factory reset.
 * An implementation that treats 100 as a rate limit and forgives it after a
 * minute has restored the brute force it was supposed to prevent.
 *
 * @category constants
 * @since 0.1.0
 */
export const LIMIT = 100

/**
 * A count of consecutive failed setup-code attempts.
 *
 * **Details**
 *
 * Four operations rather than a bare `Ref<number>`, because the interesting
 * thing about this counter is *when* each one is called and a raw number invites
 * getting that wrong. In HAP's own flow: `exhausted` is consulted at M2, before
 * any work is done, so a locked-out controller is refused before it can even
 * learn the salt; `record` happens at M4 and only when the SRP proof was wrong;
 * `reset` happens at M4 the moment the proof is right, before the response is
 * built.
 *
 * **Gotchas**
 *
 * `record` is for a wrong *setup code* and nothing else. An M5 whose signature
 * does not verify is also answered with `Authentication`, and the ADK
 * deliberately does not count it: by then the code has already been proved
 * correct, so counting it would let a controller with a broken Ed25519
 * implementation lock the accessory out of ever pairing.
 *
 * @category models
 * @since 0.1.0
 */
export interface Attempts {
  /** How many wrong setup codes have been offered since the last correct one. */
  readonly failed: Effect.Effect<number>
  /** Whether the accessory should now refuse to begin an exchange at all. */
  readonly exhausted: Effect.Effect<boolean>
  /** Count one wrong setup code. */
  readonly record: Effect.Effect<void>
  /** Forget them all, because one was right. */
  readonly reset: Effect.Effect<void>
}

/**
 * A fresh counter with a given limit.
 *
 * **Details**
 *
 * The limit is a parameter and not {@link LIMIT} directly, for one reason: a
 * test that had to fail 100 times to see the lockout would be slow enough that
 * nobody would write it, and an untested lockout is a lockout that fires on the
 * first attempt or never. Pass {@link LIMIT} anywhere real.
 *
 * The count starts at zero and lives as long as the accessory does. HAP's
 * survives a reboot; matching that means persisting it, which is a decision for
 * whatever owns the accessory's storage rather than for this module — but an
 * implementation that skips it has a lockout that a power cut clears.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { LIMIT, make } from "./Attempts.ts"
 *
 * const program = Effect.gen(function*() {
 *   const attempts = yield* make(LIMIT)
 *   yield* attempts.record
 *   return yield* attempts.exhausted // => false
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (limit: number): Effect.Effect<Attempts> =>
  Effect.map(Ref.make(0), (count) => ({
    failed: Ref.get(count),
    // `>=` rather than `>`: with a limit of three, the third wrong code is the
    // last one allowed, and the fourth attempt is refused before it starts. Off
    // by one in the other direction gives an extra guess, which is a small
    // number and an embarrassing one to have to explain.
    exhausted: Effect.map(Ref.get(count), (failures) => failures >= limit),
    record: Ref.update(count, (failures) => failures + 1),
    reset: Ref.set(count, 0)
  }))
