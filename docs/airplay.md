# AirPlay

How to use AirPlay with this CLI, and what the `@castcli/airplay` package implements.

## Using AirPlay from the CLI

### Pairing

AirPlay devices require pairing before first use. You'll see a 4-digit PIN on the TV screen when pairing is needed.

```sh
# Provide the PIN shown on your Apple TV
cast play movie.mkv --device "Apple TV" --pin 1234

# Or set it as an environment variable
export AIRPLAY_PIN=1234
cast play movie.mkv --device "Apple TV"
```

The emulator uses PIN `3939` for testing.

### Pairing storage

Pairing data is stored in `$XDG_STATE_HOME/castcli/state.json` (default: `~/.local/state/castcli/state.json`), keyed by device ID when available, with IP address as fallback.

Once paired, you don't need the PIN again unless the device is reset or pairing data is deleted.

### Fail-closed

If pair-setup or pair-verify fails, playback fails with an error. This prevents unauthenticated playback to devices that require pairing.

## What this sender implements

AirPlay 2 video with HAP (HomeKit Accessory Protocol) pairing.

### Discovery

mDNS `_airplay._tcp` on port 7000. Device announces capabilities in its TXT record as a 64-bit `features` bitmask. Video capability is `bit 0 || bit 49`:

- **Apple TVs** set bit 0 and clear 49
- **Third-party sets** (Roku, Samsung, LG) set 49 and clear 0

Both bits must be checked or half the devices are silently excluded.

### Pairing and crypto

- **HAP pair-setup** (M1-M6): establishes long-term Ed25519 keys with PIN code, using SRP-6a, Ed25519, X25519, ChaCha20-Poly1305, HKDF, TLV8
- **HAP pair-verify** (M1-M4): runs before every play session, authenticates using stored long-term keys
- **Encrypted control channel**: After pair-verify, control POSTs are encrypted with ChaCha20-Poly1305 framing (2-byte length + ciphertext + 16-byte tag). Session keys derived from pair-verify shared secret via HKDF. Nonce counter increments per frame.
- **MFi auth-setup** (sender POST only): If the device advertises bit 26 (`HasUnifiedAdvertiserInfo`) or bit 51 (`SupportsUnifiedPairSetupAndMFi`), the sender POSTs a Curve25519 public key to `/auth-setup` before pair-verify. The receiver returns its public key + encrypted signature + MFi certificate. The sender accepts any 200 response without verifying the signature. This satisfies receivers that refuse play without the exchange, while not implementing full MFi accessory protocols.

### Control surface

| Endpoint | Purpose |
|---|---|
| `POST /pair-setup` | HAP pair-setup (M1-M6), establishes long-term keys with PIN |
| `POST /pair-verify` | HAP pair-verify (M1-M4), runs before every play session |
| `POST /command` | insertPlayQueueItem with Content-Location and Start-Position (XML plist) |
| `POST /scrub?position=` | Seek |
| `POST /rate?value=` | `0` pauses, `1` resumes |
| `POST /stop` | Stop |
| `GET /playback-info` | Duration, position, rate, buffering, seekable ranges (XML or binary plist) |
| `POST /setproperty` | Set volume (0.0 to 1.0, XML plist) |

After pair-verify, all control POSTs (`/command`, `/scrub`, `/rate`, `/stop`, `/setproperty`) are encrypted.

### Pull model

The sender does not push pixels. After pair-setup (if needed) and pair-verify, it hands over a URL via play-queue (`POST /command` with `insertPlayQueueItem`), and the device fetches it. This matches Cast and DLNA: all three are pull models.

### What is deliberately not built

- **Mirroring** (push-model H.264 encoding): would invert the pull model that Cast, DLNA, and AirPlay share
- **FairPlay DRM**: `/fp-setup` gates mirroring and the audio key, not URL handoff. Open-source senders (pyatv, UxPlay) serve HLS video without FairPlay.
- **RTSP audio** (SETUP/RECORD): no audio RTP path, HTTP video only
- **Encrypted RTSP framing** (ChaCha20-Poly1305 encrypted RTP): not implemented
- **MFi authentication chip**: sender POSTs the required Curve25519 public key but does not verify the returned MFi certificate or signature

## Using `@castcli/airplay` as a library

The `@castcli/airplay` package exports:

- **`PairSetup`**: HAP pair-setup controller (M1-M6)
- **`PairVerify`**: HAP pair-verify controller (M1-M4)
- **`Suite`**: Cryptographic primitives (SRP-6a, Ed25519, X25519, ChaCha20-Poly1305, HKDF, TLV8)
- **`Session`**: AirPlay session management (`play`, `rate`, `scrub`, `stop`, `playbackInfo`, `setVolume`)
- **`AirPlayDevice`**: Device model with video capability detection from TXT record

### Example: pair and play

```typescript
import { PairSetup, PairVerify, Session, Suite, NodeSuite } from "@castcli/airplay"
import { Effect, Layer, Redacted } from "effect"
import { NodeCrypto } from "@effect/platform-node"

const program = Effect.gen(function*() {
  const suite = yield* Suite.Suite.pipe(
    Effect.provide(Layer.provide(NodeSuite, NodeCrypto.layer))
  )

  // Pair-setup (M1-M6)
  const identity = yield* Effect.gen(function*() {
    const keys = yield* suite.ed25519KeyPair
    return { identifier: crypto.randomUUID(), keys }
  })

  const m1 = yield* PairSetup.m1({ flags: [] })
  const m2 = yield* postTo("http://device-ip:7000/pair-setup", m1)

  const { request: m3, state: proved } = yield* PairSetup.m3(m2, { pin: "1234" })
  const m4 = yield* postTo("http://device-ip:7000/pair-setup", m3)

  const { request: m5, state: exchanged } = yield* PairSetup.m5(m4, {
    state: proved,
    identity
  })
  const m6 = yield* postTo("http://device-ip:7000/pair-setup", m5)

  const pairSetupResult = yield* PairSetup.finish(m6, exchanged)

  // Pair-verify (M1-M4) - run before every play session
  const pairing = {
    record: {
      controller: {
        identifier: new TextEncoder().encode(identity.identifier),
        publicKey: identity.keys.publicKey
      },
      accessory: {
        identifier: pairSetupResult.accessory.identifier,
        publicKey: pairSetupResult.accessory.publicKey
      }
    },
    controllerIdentity: identity
  }

  // Play
  yield* Session.play(device, {
    contentLocation: "http://your-server:8021/master.m3u8",
    startPosition: Seconds.make(0),
    pairing
  })
})
```

### Schema-based plist decoding

`GET /playback-info` can return XML or binary plist. The package decodes both with `@effect/schema`:

```typescript
import { PlaybackInfo } from "@castcli/airplay"

const info = yield* Session.playbackInfo(device)
// info: Option<{ duration: number, position: number, rate: number, ... }>
```

Binary plist support (`bplist00` format) is implemented for Apple TV compatibility.

## Hardware testing

Software is complete and verified against an emulated AirPlay device that requires pairing, decrypts encrypted control frames, and pulls the media URL. Hardware testing remains: an Apple TV or third-party AirPlay TV to confirm the implemented sender works end-to-end.

One gap remains unproven:

- **mDNS discovery end-to-end** (draft PR #24): the e2e test currently uses `--ip` to bypass discovery
