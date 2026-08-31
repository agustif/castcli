# cast

Stream local video files to your TV from the command line. Supports Google Cast, DLNA, and AirPlay — whichever protocol your device speaks.

```sh
cast play movie.mkv
```

The tool finds your TV, picks the best audio and subtitle tracks, resumes where you stopped, and adapts quality while it runs.

## Install

Requires Node 22+ and ffmpeg.

```sh
npm install
npm run build:cli
npm i -g .
```

Or run from source:

```sh
npm run cast -- play movie.mkv
```

## Quick start

```sh
# Play a file
cast play movie.mkv

# See what's on your network
cast scan

# Control what's playing
cast pause
cast resume
cast seek --forward 5:00
cast volume --level 50
cast stop
```

## Commands

### `cast play <file>`

Stream a file to your TV. The TV fetches the media from a local HTTP server.

**Flags:**

- `--device <name>` — Pick a device by name substring (default: last used, or first found)
- `--ip <address>` — Device IP address, skips discovery
- `--audio <index>` — Audio stream index (default: first match for `CAST_AUDIO_LANGUAGES`)
- `--subs <index>` — Subtitle stream index (default: preferred language, most cues)
- `--seek <time>` — Start position as seconds, `mm:ss`, or `h:mm:ss` (default: resume where you stopped)
- `--progressive` — Serve single-quality progressive stream instead of HLS (default: HLS)
- `--pin <code>` — AirPlay pairing PIN (or set `AIRPLAY_PIN`; prompts if neither)

**Examples:**

```sh
# Just play it
cast play movie.mkv

# Pick a specific device and audio track
cast play movie.mkv --device "Living Room" --audio 3

# Start at 12 minutes 30 seconds
cast play movie.mkv --seek 12:30

# Force progressive mode (single quality, seeking restarts ffmpeg)
cast play movie.mkv --progressive
```

### `cast scan`

List devices on your network (Cast, DLNA, and AirPlay).

### `cast streams <file>`

Show audio, video, and subtitle tracks in a file. Marks what `cast play` would choose based on your language preferences.

```sh
cast streams movie.mkv
```

### Control commands

These attach to the running session without restarting playback.

- `cast status` — Show what the device is playing
- `cast pause` / `cast resume` / `cast toggle`
- `cast seek --to 15:00` / `--forward 5:00` / `--back 30`
- `cast volume --level 50` — Set volume (0-100)
- `cast stop` — Stop playback and close the receiver

**How seeking works:**

- **HLS mode** (default): the TV seeks natively, nothing restarts
- **Progressive mode** (`--progressive`): `cast seek` asks the running player to restart ffmpeg at the new offset

## AirPlay

AirPlay devices require pairing on first use. When run interactively, the CLI prompts for the PIN. You can also provide it via `--pin` flag or `AIRPLAY_PIN` environment variable.

```sh
# Interactive: CLI prompts for the PIN shown on screen
cast play movie.mkv --device "Apple TV"

# Or provide the PIN directly
cast play movie.mkv --device "Apple TV" --pin 1234

# Or set AIRPLAY_PIN for subsequent plays
export AIRPLAY_PIN=1234
cast play movie.mkv --device "Apple TV"
```

Pairing is stored by device ID in `$XDG_STATE_HOME/castcli/state.json` (default: `~/.local/state/castcli/state.json`). Once paired, you don't need the PIN again unless the device is reset.

**Fail-closed:** if pairing or verification fails, playback fails. This CLI implements HAP pair-setup, pair-verify, encrypted control channel, and play-queue.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CAST_PORT` | 8021 | Preferred local HTTP port (falls back to free port if taken) |
| `CAST_DEVICE_PORT` | 8009 | Cast control port |
| `AIRPLAY_DEVICE_PORT` | 7000 | AirPlay control port |
| `CAST_ADVERTISE_HOST` | auto | Override the advertised LAN address |
| `CAST_AUDIO_BITRATE` | 128k | AAC bitrate for transcoded audio |
| `CAST_AUDIO_LANGUAGES` | eng,und | Audio language preference (comma-separated, best first) |
| `CAST_SUBTITLE_LANGUAGES` | eng | Subtitle language preference |
| `CAST_DISCOVERY_TIMEOUT_MS` | 4000 | mDNS discovery timeout per sweep |
| `AIRPLAY_PIN` | — | AirPlay pairing PIN |
| `XDG_STATE_HOME` | `~/.local/state` | Where pairing data and resume positions are stored |

## How it works

Your TV is a **pull client**, not a push target. `cast` runs a local HTTP server, hands the TV a URL, and the TV fetches the media:

```
cast ──TLS/HTTP──▶ TV    (control channel: Cast protobuf, DLNA SOAP, or AirPlay HTTP)
cast ◀───HTTP────── TV    (TV pulls video and subtitles)
```

This is why all three protocols are supported with one media server: Cast, DLNA, and AirPlay all use the pull model.

### HLS vs Progressive

| | HLS (default) | `--progressive` |
|---|---|---|
| What's served | VOD playlist, every segment addressable | Single continuous MP4 stream |
| Who picks quality | TV does, from its buffer | We do, by measuring |
| Changing quality | Next segment from another variant | Restart ffmpeg, reissue LOAD (visible rebuffer) |
| Seeking | TV seeks natively | Restart ffmpeg at new offset |

HLS is the default and works on all tested devices. Progressive mode exists for files without duration or receivers that reject HLS.

## Why this exists

VLC builds the URL it hands the TV from whichever local address its socket binds to. When the TV is resolved over IPv6, that address is a **link-local IPv6 address with zone index** like `http://fe80::...%en0:8010/stream`. The `%en0` names an interface on your machine, which is meaningless to the TV. The TV can't fetch it and playback fails silently.

This tool advertises an explicit LAN IPv4 address instead.

## Documentation

- [**docs/usage.md**](docs/usage.md) — How to use scan, play, control, and troubleshooting
- [**docs/airplay.md**](docs/airplay.md) — AirPlay details: pairing, what's implemented, library usage
- [**docs/architecture.md**](docs/architecture.md) — For contributors: packages, Effect patterns, testing
- [**docs/direction.md**](docs/direction.md) — Why this tool exists and what remains
- [**docs/cast-protocol.md**](docs/cast-protocol.md) — Cast wire protocol reference

## Development

```sh
npm install
npm run check       # typecheck, lint, architecture, tests, e2e
npm run build:cli   # bundle to dist/cast.cjs
```

This is an npm workspace. `npm run cast -- <args>` runs from source without a build step.

### Checks

- `npm run typecheck` — TypeScript strict mode
- `npm run lint` — Project-specific rules (Effect patterns, no hand-rolled control flow)
- `npm run depcruise` — Architecture: no cycles, imports follow the dependency graph
- `npm run codegen:check` — Generated code is up to date (Cast/UPnP/HAP vocabularies)
- `npm test` — Unit and integration tests
- `npm run test:e2e` — End-to-end: built binary against emulated Cast, DLNA, and AirPlay devices
- `npm run check` — All of the above (what CI runs)

### Project structure

```
packages/
  domain/       Branded types, domain errors, device/media models
  protocol/     Cast v2 wire format (generated from cast_channel.proto)
  media/        ffmpeg, HLS playlist generation, WebVTT codec
  quality/      Adaptive quality ladder and controller (progressive mode)
  dlna/         DLNA/UPnP: SSDP discovery, SOAP actions, renderer control
  airplay/      AirPlay: HAP pairing (pair-setup/pair-verify), crypto, session management
  platform/     Node bridges (UDP for mDNS, HTTP server, subprocess spawner)
  emulator/     Emulated Cast, DLNA, and AirPlay devices for testing
apps/
  cli/          CLI commands, flags, media server routes
tools/
  oxlint-plugin/ Custom lint rules
```

## License

MIT
