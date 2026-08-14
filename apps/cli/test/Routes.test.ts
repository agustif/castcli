// The query the receiver echoes back at us.
//
// This is three lines of parsing that has already been wrong once: the previous
// version used `Number(...) || 0` and then `|| current.offsetSeconds` at the
// call site, so `?o=0` — seek to the very start — was indistinguishable from an
// absent parameter and silently resumed from wherever the session happened to
// be. Absence and zero are different answers, and these pin that.

import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { Brands } from "@castcli/domain"
import { offsetFromUrl } from "../src/Server/Routes.ts"

describe("offsetFromUrl", () => {
  it("reads a position", () => {
    assert.deepStrictEqual(
      offsetFromUrl("/stream?o=396.09"),
      Option.some(Brands.Seconds.make(396.09))
    )
  })

  it("distinguishes the start of the film from no request at all", () => {
    assert.deepStrictEqual(offsetFromUrl("/stream?o=0"), Option.some(Brands.Seconds.make(0)))
    assert.isTrue(Option.isNone(offsetFromUrl("/stream")))
  })

  it("refuses a position that is not a number, or is negative", () => {
    // The receiver echoes back what it was handed, so a malformed value means
    // something built the URL wrongly — better absent than silently zero.
    assert.isTrue(Option.isNone(offsetFromUrl("/stream?o=banana")))
    assert.isTrue(Option.isNone(offsetFromUrl("/stream?o=-5")))
    assert.isTrue(Option.isNone(offsetFromUrl("/stream?o=")))
  })

  it("ignores parameters it does not know", () => {
    assert.deepStrictEqual(
      offsetFromUrl("/subs.vtt?o=12&nocache=99"),
      Option.some(Brands.Seconds.make(12))
    )
  })
})
