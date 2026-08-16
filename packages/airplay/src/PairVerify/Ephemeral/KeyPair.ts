/**
 * The X25519 pair each side invents for one pair-verify and then forgets.
 *
 * One file rather than two, for the same reason `Srp/Ephemeral.ts` is one file:
 * both roles need exactly the same thing — 32 random octets and the public key
 * they give — and "where the randomness comes from" is a single decision. It is
 * also the decision that makes the exchange testable, since two roles running
 * against each other with fixed keys produce the same transcript every time.
 *
 * @since 0.1.0
 */
import { Effect, Option, Redacted } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { type KeyPair, Suite } from "../../Suite/index.ts"

/**
 * The exchange's ephemeral pair: supplied, or freshly generated.
 *
 * **Details**
 *
 * With `Option.none()` the pair comes from `Suite.x25519KeyPair`, which draws
 * its scalar from Effect's `Crypto` service — so a program that wants
 * reproducibility can also get it by providing a `Crypto` layer with fixed
 * bytes, without either role knowing.
 *
 * **When to use**
 *
 * `Option.none()` anywhere real. Reusing an ephemeral key across sessions costs
 * the forward secrecy that is the only reason pair-verify does a
 * Diffie-Hellman at all: someone who records a year of sessions and later
 * learns that one scalar can derive every session key in the recording.
 *
 * `Option.some(bytes)` in a test, and the two roles must be given *different*
 * bytes. A fixed-randomness `Crypto` layer hands both sides the same scalar,
 * and an exchange where the peers share a private key still agrees on a secret
 * — so it passes, while checking nothing about the Diffie-Hellman.
 *
 * **Gotchas**
 *
 * A supplied scalar is used verbatim: no length check here beyond the one
 * `Suite` performs, and no clamping, because clamping happens inside the
 * multiplication. Bytes that are not 32 long fail as a bad argument.
 *
 * @example
 * ```ts
 * import { Option } from "effect"
 * import { keyPair } from "./KeyPair.ts"
 *
 * const ours = keyPair(Option.none()) // Effect<KeyPair, PlatformError, Suite>
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const keyPair = (
  supplied: Option.Option<Uint8Array>
): Effect.Effect<KeyPair, PlatformError, Suite> =>
  Suite.use((suite) =>
    Option.match(supplied, {
      onNone: () => suite.x25519KeyPair,
      onSome: (bytes: Uint8Array) => {
        const privateKey = Redacted.make(bytes)
        return Effect.map(
          suite.x25519PublicKey(privateKey),
          (publicKey): KeyPair => ({ publicKey, privateKey })
        )
      }
    }))
