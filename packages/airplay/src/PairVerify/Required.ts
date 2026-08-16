// Pulling an item a message cannot do without, and saying which one is missing.
//
// Private plumbing for this directory's codecs — deliberately absent from
// ./index.ts. It exists because the alternative, `Option.getOrElse(find(...),
// () => new Uint8Array())`, is available at every one of these call sites and
// is wrong in the same way each time: a missing kTLVType_Signature becomes an
// empty signature, which fails to verify, which is reported as an impostor.
// The message that matters is "the accessory did not send a signature", and it
// can only be produced here, where the name of the item is still known.
//
// Both failures are `SchemaIssue.Issue`, so a message codec built on these
// fails the way any other decoding fails and a caller needs no third error
// family for "the peer sent nonsense".

import { Effect, Option, SchemaIssue } from "effect"
import { find, type Item } from "../Tlv8/index.ts"

/**
 * The value of an item that must be present.
 *
 * `name` is the ADK's own spelling — `kTLVType_PublicKey` — because that is
 * what a reader will find in the vendored sources and in every other HomeKit
 * implementation's logs when they go looking for why a device sent no such
 * item.
 */
export const required = (
  items: ReadonlyArray<Item>,
  type: number,
  name: string
): Effect.Effect<Uint8Array, SchemaIssue.Issue> =>
  Option.match(find(items, type), {
    onNone: () =>
      Effect.fail(
        new SchemaIssue.InvalidValue(undefined, { message: `${name} is missing` })
      ),
    onSome: (value: Uint8Array) => Effect.succeed(value)
  })

/**
 * The value of an item that must be present and of an exact length.
 *
 * The length half is not defensive typing. An X25519 public key is 32 bytes and
 * an Ed25519 signature is 64, and a value of the wrong length reaches the
 * platform's cryptography as a bad argument — an `ERR_CRYPTO_*` from inside
 * OpenSSL, or in the worst case a value spliced into a DER template whose
 * length bytes say otherwise. Checked here it names the item and both lengths,
 * at the point where the sender is still identifiable as the one at fault.
 */
export const exactly = (
  items: ReadonlyArray<Item>,
  type: number,
  name: string,
  length: number
): Effect.Effect<Uint8Array, SchemaIssue.Issue> =>
  Effect.flatMap(required(items, type, name), (value) =>
    value.length === length
      ? Effect.succeed(value)
      : Effect.fail(
        new SchemaIssue.InvalidValue(undefined, {
          message: `${name} is ${length} bytes, got ${value.length}`
        })
      ))
