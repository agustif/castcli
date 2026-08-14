// The brands exist to reject values, so these tests are mostly about what they
// refuse. Several of these cases were real defects before the schemas were
// tightened, and are pinned here so they cannot come back.

import { assert, describe, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import {
  AudioBitrate,
  Bitrate,
  FilePath,
  Height,
  Ipv4,
  MediaSessionId,
  Port,
  Seconds,
  SessionId,
  StreamIndex,
  TransportId,
  VolumeLevel
} from "../src/Brands.ts"

describe("Ipv4", () => {
  it("accepts a dotted quad", () => {
    assert.isTrue(Schema.is(Ipv4)("192.168.1.24"))
    assert.isTrue(Schema.is(Ipv4)("0.0.0.0"))
    assert.isTrue(Schema.is(Ipv4)("255.255.255.255"))
  })

  it("rejects octets out of range", () => {
    // Both of these passed before the pattern checked octet ranges rather than
    // just the shape — in the brand whose whole job is rejecting addresses a
    // device cannot be reached at.
    assert.isFalse(Schema.is(Ipv4)("256.0.0.1"))
    assert.isFalse(Schema.is(Ipv4)("999.999.999.999"))
  })

  it("rejects leading zeros, which some resolvers read as octal", () => {
    assert.isFalse(Schema.is(Ipv4)("00.0.0.0"))
    assert.isFalse(Schema.is(Ipv4)("192.168.01.1"))
  })

  it("rejects anything that is not a dotted quad", () => {
    assert.isFalse(Schema.is(Ipv4)("not-an-ip"))
    assert.isFalse(Schema.is(Ipv4)("192.168.1"))
    assert.isFalse(Schema.is(Ipv4)("192.168.1.1.1"))
    // The bug this whole tool works around: a link-local IPv6 address with a
    // zone index, which the receiver cannot route back to.
    assert.isFalse(Schema.is(Ipv4)("fe80::4a9:f44d:e221:9bf1%en0"))
  })
})

describe("VolumeLevel", () => {
  it("accepts the receiver's 0..1 scale", () => {
    assert.isTrue(Schema.is(VolumeLevel)(0))
    assert.isTrue(Schema.is(VolumeLevel)(0.2))
    assert.isTrue(Schema.is(VolumeLevel)(1))
  })

  it("rejects a percentage, which used to be silently clamped", () => {
    // `setVolume(20)` — a plausible way to mean twenty percent — became full
    // volume before this was branded.
    assert.isFalse(Schema.is(VolumeLevel)(20))
    assert.isFalse(Schema.is(VolumeLevel)(-1))
  })
})

describe("AudioBitrate", () => {
  it("accepts ffmpeg's spelling", () => {
    assert.isTrue(Schema.is(AudioBitrate)("128k"))
    assert.isTrue(Schema.is(AudioBitrate)("320k"))
  })

  it("rejects a bare number or a wrong unit", () => {
    // This string is passed to ffmpeg verbatim, so a typo would fail
    // mid-transcode rather than at startup.
    assert.isFalse(Schema.is(AudioBitrate)("128"))
    assert.isFalse(Schema.is(AudioBitrate)("128kb"))
    assert.isFalse(Schema.is(AudioBitrate)("high"))
  })
})

describe("Port", () => {
  it("accepts a usable port", () => assert.isTrue(Schema.is(Port)(8009)))

  it("rejects out-of-range and fractional ports", () => {
    assert.isFalse(Schema.is(Port)(0))
    assert.isFalse(Schema.is(Port)(70_000))
    assert.isFalse(Schema.is(Port)(8009.5))
  })
})

describe("numeric brands", () => {
  it("rejects negative positions and non-positive rates", () => {
    assert.isFalse(Schema.is(Seconds)(-1))
    assert.isFalse(Schema.is(Bitrate)(0))
    assert.isFalse(Schema.is(Height)(0))
    assert.isFalse(Schema.is(StreamIndex)(-1))
  })

  it("requires whole numbers where the wire does", () => {
    assert.isFalse(Schema.is(StreamIndex)(1.5))
    assert.isFalse(Schema.is(MediaSessionId)(1.5))
    // A position, by contrast, is legitimately fractional.
    assert.isTrue(Schema.is(Seconds)(90.5))
  })
})

describe("identifier brands", () => {
  it("rejects empty identifiers", () => {
    // An empty transport id is accepted by the wire schema and then addressed
    // to, which produces silence rather than an error.
    assert.isFalse(Schema.is(TransportId)(""))
    assert.isFalse(Schema.is(SessionId)(""))
    assert.isFalse(Schema.is(FilePath)(""))
  })
})

describe("constructors", () => {
  it("makeOption is absent for an invalid value", () => {
    assert.isTrue(Option.isNone(Ipv4.makeOption("256.0.0.1")))
    assert.isTrue(Option.isSome(Ipv4.makeOption("192.168.1.24")))
  })

  it("makeEffect keeps the failure in the error channel", () =>
    assert.isTrue(Option.isNone(VolumeLevel.makeOption(20))))
})
