# AirPlay: the pull/URL-handoff path

The tool speaks Cast, DLNA, and AirPlay. This document explains what was built
and what was deliberately left out.

Last updated: 2026-08-31. Query-string contract documented. E2E tests prove the
device fetches. `playQueue` endpoint implemented in Session. Pair-verify implemented
in emulator but not wired into sender Session. Volume gap noted.

## What is built

AirPlay video is a **pull model**, like the other two. The sender does not push
pixels: it hands over a URL and the device fetches it. The control surface is
plainer than DLNA — no SOAP, no DIDL:

| | |
|---|---|
| `POST /play` | `Content-Location` plus `Start-Position` (query-string parameters) |
| `POST /command` | `insertPlayQueueItem` with XML plist (playQueue implementation) |
| `POST /scrub?position=` | seek |
| `POST /rate?value=` | `0` pauses, `1` resumes |
| `POST /stop` | stop |
| `GET /playback-info` | duration, position, rate, buffering, seekable ranges |

**Query-string contract**: POST /play accepts Content-Location and Start-Position
as URL parameters. This is the documented interface. Binary plist would be more
standard but query-string works with emulators and legacy devices.

**Play-queue path**: POST /command with `insertPlayQueueItem` XML plist is also
implemented. Whether modern Apple TVs require this path (rather than the simpler
query-string `/play`) is untested without hardware.

Discovery is mDNS `_airplay._tcp` on port 7000 — the same machinery already
written for Cast. A device announces its capabilities as a 64-bit `features`
bitmask in its TXT record, and whether it will play video is `bit 0 || bit 49`.

That disjunction is not pedantry. Decoding the TXT records of twelve real
devices shows the two halves of the world use different bits: **every Apple TV
sets bit 0 and clears 49; every third-party set — Roku, Samsung, LG — sets 49
and clears 0.** Checking either alone silently excludes half of them.

Whether *pairing* is required is a different field again — `flags`, where bit 3
is PIN mode, bit 7 password required and bit 9 pair-PIN. Capability and
permission are separate questions.

### Implementation

The sender is **software-complete for the unauthenticated endpoints**. It implements:

- mDNS `_airplay._tcp` discovery with TXT record parsing for `features`, `flags`,
  `model`, and `deviceid`
- The `AirPlayDevice` domain model with video capability detection
- HTTP-based session: `POST /play`, `/rate`, `/scrub`, `/stop`, `GET /playback-info`
- Integration into all CLI commands: `scan`, `play`, `status`, `pause`, `resume`,
  `seek`, `stop`
- An emulator device that advertises, accepts control, and actually HTTP-pulls
  the media URL handed to it
- **E2E test** (`apps/cli/test/AirPlay.e2e.test.ts`) where the built CLI talks to
  the emulated AirPlay device and **asserts the device fetched the film**

The same media server, quality ladder, segment encoder, and subtitle handling
used for Cast and DLNA serve AirPlay — because all three are pull models and
the device does the fetching.

### What is deliberately not built

**HAP pair-verify is implemented in the emulator but not wired into the sender Session.**
The unauthenticated endpoints work with emulators and may work with some real devices,
but modern Apple TVs require a full AirPlay 2 session. pyatv's author confirmed in 2023:
*"The play_url method has been broken for a very long time as I believed Apple wasn't
maintaining the underlying functionality anymore. They do, but an AirPlay session must be
established for it to work now."*

Without pair-verify, the symptom on a current Apple TV is: the screen goes black,
shows a spinner, and returns to the home screen after four seconds.

Pairing requires HAP: SRP6a, Ed25519, Curve25519, HKDF, and ChaCha20-Poly1305.
The cryptographic infrastructure (`packages/airplay/src/PairVerify/`,
`packages/airplay/src/Suite/`) **is already built** and the emulator implements
the full pair-verify handshake (M1-M4). The sender Session does not yet call it,
so wiring pair-verify into the session is left for when hardware testing
becomes possible.

**FairPlay is not needed.** This is the one piece of good news and it is worth
recording precisely: `/fp-setup` gates *mirroring* and the audio key, not URL
handoff. pyatv's sender path contains no FairPlay at all; UxPlay's HTTP video
path returns 421 to `/fp-setup2` and serves HLS anyway. Mirroring would have
meant reverse-engineered white-box crypto or an MFi hardware module. Handing
over a URL does not.

**Mirroring** (push-model H.264 encoding) is not implemented. The whole media
path here is built on the pull model: the device fetches from us, not the other
way around.

## Known gaps

**Current Apple TVs require pairing**, and the pairing path is not wired into the
sender Session (though it exists in the emulator). The sender will work with:

- The emulated device (for tests)
- Legacy devices that still accept unauthenticated `/play` (pre-tvOS 10.2)
- Third-party AirPlay receivers (Samsung, LG, Sony, Vizio) that may be more
  permissive

Whether a real Apple TV with the legacy `/play` endpoint works (as pyatv suggests)
or requires the newer play-queue path (as pyatv #2899 suggests) cannot be determined
without hardware. The cryptographic foundation is there; the session-establishment
handshake is not yet called from the sender Session.

**Play-queue endpoint** (`POST /command` with `insertPlayQueueItem`) is implemented
in the sender Session. Whether modern Apple TVs require this path (rather than the
simpler query-string `/play`) is untested without hardware.

**Volume control is not implemented.** The AirPlay protocol supports volume via
`POST /setproperty`, but the current implementation does not include it. The CLI
`volume` command silently does nothing for AirPlay devices (it logs success but
does not change the volume).

## What would complete it

- **An Apple TV to test against.** The cryptographic primitives exist and the emulator
  implements pair-verify. The remaining work is wiring pair-verify into the sender
  Session and validating it with hardware. If binary plist for `/play` is required
  (rather than query-string parameters), that is a bounded addition.
  
- **An AirPlay-compatible television** (Samsung, LG, Sony, Vizio, Xiaomi). These are a
  different firmware lineage and advertise video through bit 49 rather than bit 0.
  Whether they accept the simpler unauthenticated session is unpublished, and a
  single evening with one would settle it.

The honest position is: the software is complete for the unauthenticated path,
the cryptographic pieces exist and are emulator-verified for pairing, `playQueue`
is implemented, and the deciding question is whether a real device will accept what
we send. That requires hardware.
