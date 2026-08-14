// Error messages are a user interface. These pin the ones a person is most
// likely to see, because the failure mode they replaced was a stack trace or a
// raw regular expression printed at someone trying to watch a film.

import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, SchemaIssue } from "effect"
import { DeviceUnreachableError } from "../src/Errors.ts"
import { AudioBitrate, Ipv4, VolumeLevel } from "../src/Brands.ts"

// A schema failure is an `Issue`, not an `Error`, so it has to be rendered the
// same way the CLI renders it. `flip` turns the failure into the success value,
// which avoids stringifying a whole Cause — that carries AST internals which
// have nothing to do with what a person is shown.
const formatIssue = SchemaIssue.makeFormatterDefault()

const messageOf = <A>(effect: Effect.Effect<A, SchemaIssue.Issue>) =>
  Effect.runSyncExit(Effect.flip(effect)).pipe(
    Exit.match({ onFailure: () => "", onSuccess: formatIssue })
  )

describe("DeviceUnreachableError", () => {
  it("says what to check rather than showing a socket trace", () => {
    const error = new DeviceUnreachableError({
      ip: "192.168.1.99",
      port: 8009,
      cause: new Error("ETIMEDOUT")
    })
    assert.include(error.message, "192.168.1.99:8009")
    assert.include(error.message, "cast scan")
  })
})

describe("validation messages", () => {
  it("names what a valid address looks like instead of printing the pattern", () => {
    const message = messageOf(Ipv4.makeEffect("999.1.1.1"))
    assert.include(message, "192.168.1.24")
    assert.notInclude(message, "RegExp")
  })

  it("explains the volume scale, which is the mistake people actually make", () => {
    assert.include(messageOf(VolumeLevel.makeEffect(20)), "percentage")
  })

  it("gives an example bitrate", () => {
    assert.include(messageOf(AudioBitrate.makeEffect("128")), "128k")
  })
})
