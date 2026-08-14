# cast

Stream a local video file to a Google Cast device from the command line.

Written because VLC could not do it, for a reason worth recording.

## The bug this exists to work around

VLC 3 builds the URL it hands the TV from whichever local address its socket
happens to be bound to. When the device is resolved over IPv6, that address is a
**link-local IPv6 address with an interface zone index**:

```
stream_out_chromecast: s_chromecast_url: http://fe80::4a9:f44d:e221:9bf1%en0:8010/chromecast/.../stream
stream_out_chromecast error: Media load failed
```

`%en0` names an interface on *the sending machine*. It is meaningless on the TV,
and the address is not bracketed as a valid URL host either. The TV cannot fetch
it, replies `LoadFailed`, and VLC retries once with full transcoding before
giving up — which looks, on screen, like the renderer flashing once and doing
nothing.

It is not a codec problem, not the certificate prompt, and not hardware
decoding. `cast` advertises an explicit LAN IPv4 address instead.

## How it works

The device is a **pull** client, not a push target. `cast` runs a small HTTP
server, hands the receiver a URL, and the receiver fetches from it:

```
  cast ──TLS:8009──▶ TV          control channel (Cast v2 protobuf)
  cast ◀──HTTP:8021── TV         the TV pulls video and subtitles
```

ffmpeg remuxes on the fly into fragmented MP4. Video is stream-copied whenever
the source is already H.264 8-bit 4:2:0 at 1080p or below; only the audio is
always re-encoded, because Cast receivers reject AC-3 and E-AC-3 and never
accept Matroska as a container whatever the source was.

## Install

Requires Node 22+ and ffmpeg on `PATH`.

```sh
npm install
npm run check   # typecheck, lint, architecture, codegen drift, tests
```

This is an npm workspace. `npm run cast -- <args>` runs the CLI from source;
there is no build step in the loop, because package names resolve to each
package's barrel through tsconfig paths.

## Usage

```sh
# What's on the network?
cast scan

# What's in the file? (audio and subtitle stream indices)
cast streams movie.mkv

# Play it
cast play movie.mkv --device "Living Room" --audio 3 --subs 5

# Skip discovery when mDNS is unreliable
cast play movie.mkv --ip 192.168.1.24 --seek 12:30
```

### Flags

| Flag | Meaning |
|---|---|
| `--device <substring>` | Pick a device by name |
| `--ip <address>` | Device address, skipping discovery |
| `--audio <index>` | Audio stream index (see `cast streams`) |
| `--subs <index>` | Subtitle stream index, served as a WebVTT sidecar |
| `--seek <time>` | Start position: `90`, `1:30` or `1:02:03` |

Flags are validated by Schema before anything opens a socket:

```
$ cast play movie.mkv --ip not-an-ip
ERROR
  Invalid value for flag --ip: "not-an-ip". Expected: Schema validation failed:
  Expected a string matching the RegExp ^(\d{1,3}\.){3}\d{1,3}$
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `CAST_PORT` | 8021 | Local HTTP port the receiver pulls from |
| `CAST_DEVICE_PORT` | 8009 | Cast control port |
| `CAST_ADVERTISE_HOST` | auto | Override the advertised LAN address |
| `CAST_AUDIO_BITRATE` | 128k | AAC bitrate |
| `CAST_DISCOVERY_TIMEOUT_MS` | 4000 | Per-sweep mDNS timeout |
| `CAST_DEVICE_IP` | — | Pin the device, skipping discovery |

## Adaptive quality

Quality adapts to the link automatically. The hard part is that **spare
bandwidth cannot be measured directly**: in steady state the delivery rate
equals the encoded bitrate, so throughput only ever tells you the current rung
fits, never whether a higher one would. Three signals get around that:

1. **Startup bursts.** ffmpeg encodes faster than realtime until the socket
   backs up, so just after any restart the drain rate is the link's real
   capacity. Every rung change restarts ffmpeg, so each switch yields a fresh
   measurement for free.
2. **Stalls.** The receiver reporting `BUFFERING` is unambiguous evidence the
   current rung does not fit.
3. **Probing.** After a stable stretch, try one rung higher and watch.

A probe is an experiment, and **only a stall refutes it**. That rule is load
bearing: every upshift restarts ffmpeg and so produces a new burst reading which
is, by construction, below the rung just moved to. Acting on it reversed the
probe before the rung had ever played, and the stream oscillated forever. A
probe that survives without stalling is accepted instead, and its bitrate
becomes evidence about capacity.

Penalties for a rung that stalled expire on a timer *and* early once a later
measurement shows the link recovered, so one brief dip cannot cap quality for
the next five minutes. A real session on a degraded link looks like this:

```
quality: 540p @ 1.8 Mbps -> 360p @ 0.8 Mbps (measured ~1.9 Mbps)
quality: 360p @ 0.8 Mbps -> 480p @ 1.2 Mbps (stable, probing higher)
quality: 480p @ 1.2 Mbps -> 360p @ 0.8 Mbps (receiver was buffering)
quality: link recovered (~2.5 Mbps), retrying 480p @ 1.2 Mbps
quality: 480p @ 1.2 Mbps accepted (no stalls)
quality: 540p @ 1.8 Mbps accepted (no stalls)
```

Pin it with `CAST_*` config or extend the ladder in `packages/quality/src/Ladder.ts`.

## Subtitles

Subtitles are extracted from the container **once**, at startup, and held in
memory as structured cues. This is not an optimisation, it is a correctness fix:
piping ffmpeg straight into the HTTP response produced a chunked reply with no
`Content-Length` that took ~6 seconds to finish, and a Cast receiver parses such
a track *progressively* — so cues accumulated on screen instead of replacing one
another. Holding the cues also makes seeking free: re-cutting for a new offset
is a filter and a subtraction rather than another pass over a multi-gigabyte
container.

Three further receiver quirks are handled, each of which silently breaks
subtitles:

- a `TEXT` track with no `language` is **ignored without error**;
- `activeTrackIds` in `LOAD` is not honoured — a follow-up `EDIT_TRACKS_INFO` is
  what actually enables the track;
- the previous track must be explicitly cleared before a reload, or the receiver
  leaves its already-rendered cues painted on screen and draws the new ones
  above them.

Note also that a track flagged `default` is often a *forced* signage track with
a couple of dozen cues, not dialogue. `cast streams` shows the indices; pick the
one with the cue count you expect.

## Layout

```
packages/
  domain/       branded scalars, typed errors, media and device models
  protocol/     Cast v2 wire format, message schemas, TLS transport, session,
                and the vendored cast_channel.proto it is generated from
  media/        ffmpeg invocations as typed values, WebVTT as a Schema codec
  quality/      ladder, signals (state → phase), controller (phase → action)
  platform/     generic Node bridges: UDP for mDNS, http.createServer
apps/
  cli/          commands, schema-validated flags, the media server routes
tools/
  oxlint-plugin/ the project's own lint rules
```

`packages/domain` sits at the base of the graph and imports no other workspace
package — enforced by a lint rule, because tsconfig paths would otherwise let
such an import resolve.

## Checks

| Command | What it protects |
|---|---|
| `npm run typecheck` | strict TypeScript, `exactOptionalPropertyTypes` on |
| `npm run lint` | 24 project rules — see below |
| `npm run depcruise` | no cycles, Node builtins stay in `platform`/`protocol`, packages never import the app |
| `npm run codegen:check` | the generated wire descriptors still match the vendored `.proto` |
| `npm test` | 50 tests |
| `npm run check` | all of the above |

The lint rules encode one idea: never hand-roll what Effect provides. `no-if`,
`no-try-catch`, `no-throw`, `no-await`, `no-timers`, `no-date-now`,
`no-process-env`, `no-console`, `no-json-parse`, `no-schema-sync`,
`no-as-cast`, `no-non-null`, `no-any` and more. `packages/platform/**`,
`scripts/**` and tests carry narrow, documented exemptions.

## Validation

Every value is decoded at the boundary it arrives on, and carries a brand
afterwards so it cannot be confused with a different number or string:

| | Rejects |
|---|---|
| `Ipv4` | `256.0.0.1`, `999.999.999.999`, leading zeros, `fe80::…%en0` |
| `Port` | `0`, `70000`, `8009.5` |
| `VolumeLevel` | `20` — a percentage, which used to be clamped to full volume |
| `AudioBitrate` | `128`, `128kb` — this string reaches ffmpeg verbatim |
| `Seconds` / `Bitrate` / `Height` | negatives and non-positive rates |
| `StreamIndex` / `MediaSessionId` | fractions |
| `TransportId` / `SessionId` / `FilePath` | empty strings |

Absence is `Option`, never `null` or a magic zero — the source bitrate a
container omits, an audio track that does not exist, a subtitle index that was
not asked for, a probe that is not running.

Two of these caught real bugs rather than style: `no-schema-sync` found
`Schema.decodeSync` in the WebVTT codec turning parse failures into defects,
and removing the `as` casts exposed an `Ipv4` brand that accepted
`999.999.999.999`.

## Control

```sh
cast status --ip 192.168.1.24     # what is it playing?
cast toggle                       # pause if playing, resume if paused
cast pause / cast resume
cast volume --level 20
cast stop
```

These attach to the running session rather than launching a new one, so
pausing does not restart the film.

## Known gaps

- **Effect has no TLS/TCP client socket.** `effect/unstable/socket` is
  WebSocket-only, so `Platform/CastSocket.ts` wraps `node:tls` — but exposes it
  as a real `Socket.Socket` via `Socket.fromTransformStream`.
- **Effect has no UDP.** mDNS therefore uses `node:dgram` in `Platform/Mdns.ts`.
- **Quality switches are visible.** Changing rung restarts ffmpeg and reissues
  `LOAD`, which the viewer sees as a brief rebuffer. HLS with variant playlists
  would let the receiver switch seamlessly; that is the natural next step.
- **dependency-cruiser cannot see type-only imports here.** It does not yet
  support TypeScript 7, so it runs without the TS transpiler and
  `import type` edges are invisible to it. Value imports are checked.

See `docs/` for the protocol notes and the Effect adoption audit.
