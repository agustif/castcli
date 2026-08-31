# AirPlay: HAP pair-setup, pair-verify, then play-queue over HTTP

The tool speaks Cast, DLNA, and AirPlay. This document explains what was built
and what was deliberately left out.

Last updated: 2026-08-31. AirPlay 2 protocol implemented: HAP pair-setup (M1-M6)
and pair-verify (M1-M4), then play-queue (POST /command insertPlayQueueItem).
Volume control implemented. CLI performs pair-setup (PIN 3939 for emulator) then
pair-verify automatically.

## What is built

AirPlay 2 video is a **pull model**, like the other two. The sender does not push
pixels: after pair-setup (if needed) and pair-verify, it hands over a URL via
play-queue, and the device fetches it. The control surface is plainer than DLNA
— no SOAP, no DIDL:

| | |
|---|---|
| `POST /pair-setup` | HAP pair-setup (M1-M6), establishes long-term keys with PIN |
| `POST /pair-verify` | HAP pair-verify (M1-M4), runs before every play session |
| `POST /command` | insertPlayQueueItem with Content-Location and Start-Position (XML plist) |
| `POST /scrub?position=` | seek |
| `POST /rate?value=` | `0` pauses, `1` resumes |
| `POST /stop` | stop |
| `GET /playback-info` | duration, position, rate, buffering, seekable ranges |
| `POST /setproperty` | set volume (0.0 to 1.0, XML plist) |

Discovery is mDNS `_airplay._tcp` on port 7000 — the same machinery already
written for Cast. A device announces its capabilities as a 64-bit `features`
bitmask in its TXT record, and whether it will play video is `bit 0 || bit 49`.

That disjunction is not pedantry. Decoding the TXT records of twelve real
devices shows the two halves of the world use different bits: **every Apple TV
sets bit 0 and clears 49; every third-party set — Roku, Samsung, LG — sets 49
and clears 0.** Checking either alone silently excludes half of them.

### Implementation

The sender implements **AirPlay 2 with HAP pair-setup, pair-verify, and play-queue**:

- mDNS `_airplay._tcp` discovery with TXT record parsing for `features`, `flags`,
  `model`, and `deviceid`
- The `AirPlayDevice` domain model with video capability detection
- **HAP pair-setup** (M1-M6): establishes long-term Ed25519 keys with PIN code
  (3939 for emulator testing), using existing PairSetup.Controller and Suite
  primitives (SRP-6a, Ed25519, X25519, ChaCha20-Poly1305, HKDF)
- **HAP pair-verify** (M1-M4): runs before every play session, authenticates
  using stored long-term keys, using PairVerify.Controller
- **CLI pairing workflow**: retrieves stored pairing or runs pair-setup, always
  runs pair-verify before play, fails closed if pairing/verify fails
- **Pairing persistence**: stores controller and accessory keys in
  `XDG_STATE_HOME/castcli/state.json` keyed by device IP
- HTTP-based session:
  - `POST /command` insertPlayQueueItem (AirPlay 2 play-queue, feature bit 33)
  - `POST /setproperty` for volume control (0.0 to 1.0)
  - `POST /rate`, `/scrub`, `/stop`, `GET /playback-info`
- Integration into all CLI commands: `scan`, `play`, `volume`, `status`, `pause`,
  `resume`, `seek`, `stop`
- An emulator device that:
  - Advertises via mDNS
  - Implements pair-setup (M1-M6) and pair-verify (M1-M4) with `requirePairing` mode
  - Accepts POST /command after successful pair-verify (requirePairing=true)
  - Rejects unauthenticated requests with 403 when requirePairing=true
  - Actually HTTP-pulls the media URL handed to it
- **E2E test** (`apps/cli/test/AirPlay.e2e.test.ts`) where the built CLI runs
  pair-setup, pair-verify, and play-queue command to the emulated AirPlay device
  with `requirePairing=true` and **asserts the device fetched the film**

The same media server, quality ladder, segment encoder, and subtitle handling
used for Cast and DLNA serve AirPlay — because all three are pull models and
the device does the fetching.

### What is deliberately not built

**FairPlay is not needed.** This is the one piece of good news and it is worth
recording precisely: `/fp-setup` gates *mirroring* and the audio key, not URL
handoff. pyatv's sender path contains no FairPlay at all; UxPlay's HTTP video
path returns 421 to `/fp-setup2` and serves HLS anyway. Mirroring would have
meant reverse-engineered white-box crypto or an MFi hardware module. Handing
over a URL does not.

**Mirroring** (push-model H.264 encoding) is not implemented. The whole media
path here is built on the pull model: the device fetches from us, not the other
way around.

**Encrypted RTSP framing** (ChaCha20-Poly1305 encrypted RTP audio) is not
implemented. This implementation does HTTP video only with no audio RTP path.

**Encrypted control channel** (ChaCha20-Poly1305 framing of HTTP after
pair-verify) is not implemented. The current implementation sends plaintext HTTP
after pair-verify. Real devices may require encrypted framing for some commands.

## Known gaps

**Binary plist decoding** for playback-info is not implemented. The current
implementation parses XML plists only.

**mDNS discovery e2e** is not tested. The e2e test uses `--ip` to bypass
discovery.

**MFi /auth-setup** (Apple Authentication Coprocessor) is not implemented.

**RTSP audio** (SETUP/RECORD) is not implemented. This is HTTP video only.

## What would complete it

- **An Apple TV to test against.** The cryptographic implementation is complete;
  hardware testing would reveal whether encrypted control-channel framing or
  other details are required.
  
- **Encrypted control channel framing** if real devices require it after
  pair-verify.
