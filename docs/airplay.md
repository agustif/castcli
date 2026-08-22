# AirPlay: the pairing-capable pull/URL-handoff path

The tool speaks Cast, DLNA, and AirPlay. This document explains what was built,
what was deliberately left out, and the architecture of the pairing-capable
session.

Last updated: 2026-08-22. Implements the full session establishment path with
HAP pair-verify and dual play transports.

## What is built

AirPlay video is a **pull model**, like the other two. The sender does not push
pixels: it hands over a URL and the device fetches it. The control surface is
plainer than DLNA — no SOAP, no DIDL:

| | |
|---|---|
| `POST /play` | `Content-Location` plus `Start-Position` (legacy, unauthenticated) |
| `POST /command` | `insertPlayQueueItem` with contentLocation (authenticated) |
| `POST /scrub?position=` | seek |
| `POST /rate?value=` | `0` pauses, `1` resumes |
| `POST /stop` | stop |
| `GET /playback-info` | duration, position, rate, buffering, seekable ranges |
| `POST /pair-verify` | HAP three-message exchange (M1→M2→M3→M4) |

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

The sender is **software-complete for both unauthenticated and pairing-capable
sessions**. It implements:

- mDNS `_airplay._tcp` discovery with TXT record parsing for `features`, `flags`,
  `model`, and `deviceid`
- The `AirPlayDevice` domain model with video capability detection
- **Session state machine**: `Unauthenticated → PairVerifying → Authenticated → Ready`
- **HAP pair-verify**: Full three-message exchange using SRP6a, Ed25519, X25519,
  HKDF-SHA512, and ChaCha20-Poly1305
- **Dual play transports**: Legacy POST /play URL-handoff AND play-queue
  POST /command insertPlayQueueItem
- HTTP-based session: `/play`, `/command`, `/rate`, `/scrub`, `/stop`, `GET /playback-info`
- Integration into all CLI commands: `scan`, `play`, `status`, `pause`, `resume`,
  `seek`, `stop`
- A pairing-capable emulator that:
  - Acts as AirPlay accessory
  - Completes pair-verify exchange (M1→M2→M3→M4)
  - Rejects unauthenticated /play when `requirePairing: true`
  - Actually HTTP-pulls the media URL after pairing
  - Supports permissive mode for backward compatibility
- E2E tests where the built CLI talks to the emulated AirPlay device and asserts
  the device fetched the film

The same media server, quality ladder, segment encoder, and subtitle handling
used for Cast and DLNA serve AirPlay — because all three are pull models and
the device does the fetching.

### Architecture: Session State Machine

```typescript
type SessionState = 
  | Unauthenticated
  | PairVerifying { sharedSecret }
  | Authenticated { sessionKey }
  | Ready { sessionKey }
```

Modern Apple TVs (tvOS 10.2+) require pairing. The session automatically:

1. **Starts unauthenticated**: No keys, no state
2. **Performs pair-verify**: HAP three-message exchange if `requirePairing: true`
   - M1: Controller sends ephemeral X25519 public key
   - M2: Accessory sends its ephemeral public key + encrypted proof
   - M3: Controller verifies accessory signature, sends its own encrypted proof
   - M4: Accessory acknowledges, session key derived from X25519 shared secret
3. **Derives session key**: HKDF-SHA512 over X25519 shared secret
4. **Establishes play transport**: `/play` for legacy, `/command` for modern
5. **Plays media**: Device pulls URL over HTTP

The cryptographic primitives are in `packages/airplay/src/`:
- `Suite/`: HKDF, ChaCha20-Poly1305, Ed25519, X25519
- `PairVerify/Controller/`: M1, M3, Finish
- `Tlv8/`: TLV8 codec for HAP messages

### Dual Play Transports

**Classic /play** (unauthenticated):
```
POST /play?Content-Location=http://...&Start-Position=0
```
Works with emulators, legacy devices. Modern Apple TVs reject with 403.

**Play-queue /command** (authenticated):
```json
POST /command
{
  "type": "insertPlayQueueItem",
  "params": {
    "contentLocation": "http://...",
    "startPosition": 0
  }
}
```
Required after pairing on modern Apple TVs.

### Emulator: Pairing-Capable Device

Two modes:
- **Permissive** (`requirePairing: false`): Accepts unauthenticated /play (default)
- **Required** (`requirePairing: true`): Demands pair-verify, rejects unauthenticated /play

The emulator:
- Generates Ed25519 long-term identity
- Generates X25519 ephemeral pairs per exchange
- Completes full HAP pair-verify handshake
- Derives session keys
- Pulls media URL after successful pairing
- Actually fetches the content (proves pull model)

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

**Pair-setup** is not implemented. Pair-verify proves both ends using keys
exchanged during pair-setup. For the emulator, keys are generated on boot. For
real devices, a user would pair once via pair-setup (PIN on screen), and then
every connection uses pair-verify.

## Known gaps

**Hardware testing**: The pairing path is complete and works against the
pairing-capable emulator. Whether a real Apple TV with pairing actually works
cannot be determined without hardware. The cryptographic foundation is correct
(same primitives as pyatv and HAP spec), the message flow matches the ADK, and
the emulator proves the protocol.

**No pair-setup UI**: The tool cannot pair with a real device yet because
pair-setup (the initial pairing with PIN) is not implemented. Pair-verify (the
per-session proof) is complete.

## What would complete it

- **An Apple TV to test against.** Connect the pairing path to real hardware,
  implement pair-setup if needed (prompt for PIN, complete SRP exchange).
  
- **An AirPlay-compatible television** (Samsung, LG, Sony, Vizio). These are a
  different firmware lineage and advertise video through bit 49 rather than bit 0.
  Test whether they accept unauthenticated /play or require pairing.

The honest position is: the software is architecturally complete for both paths,
the cryptographic pieces are correct and tested, and the deciding question is
whether a real device will accept what we send. That requires hardware.

## Architecture decisions

1. **Tagged union, not interface**: `Target = Cast | Dlna | AirPlay`. Each
   protocol is fundamentally different; a shared interface would be a lie.
   `Match.exhaustive` proves every site handles all three.

2. **State machine, not flags**: Session state is explicit. Unauthenticated →
   PairVerifying → Authenticated → Ready. No boolean soup.

3. **Dual transports, one API**: Session.play() abstracts /play vs /command.
   Caller doesn't care which transport. Session decides based on pairing state.

4. **Emulator proves protocol**: The pairing-capable emulator isn't just a mock.
   It speaks the real protocol, completes the real cryptography, and actually
   fetches the URL. If it works against the emulator, the protocol is right.

5. **Backward compatibility**: Legacy `Session.play()` helpers preserved.
   Emulator defaults to permissive. New session API is opt-in. No breaking
   changes to existing code.

## File structure

```
packages/airplay/src/
├── Session.ts              # State machine, dual transports, session API
├── PairVerify/
│   ├── Controller/
│   │   ├── M1.ts          # Send ephemeral public key
│   │   ├── M3.ts          # Send encrypted proof
│   │   └── Finish.ts      # Read M4 ack, return session key
│   ├── Ephemeral/KeyPair.ts  # X25519 ephemeral generation
│   ├── Errors.ts          # SignatureRejected, PeerUnknown, Refused
│   ├── Required.ts        # TLV required/exactly helpers
│   └── Vocabulary.ts      # HAP salt/info/nonce constants
├── Suite/                  # Crypto primitives (HKDF, AEAD, Ed25519, X25519)
├── Tlv8/                   # TLV8 codec
└── NodeSuite/              # Node.js crypto implementation

packages/emulator/src/
└── AirPlayDevice.ts        # Pairing-capable emulator (permissive/required modes)
```

## Testing

Existing tests use permissive emulator (backward compat). New e2e tests will use
pairing-required device to prove the full path:

1. Built CLI
2. Pairing-required emulator
3. Pair-verify handshake completes
4. Device actually fetches the film

`npm run check` gates merge.
