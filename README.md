# cast

Stream a local video file to a television from the command line — Google Cast
or DLNA, whichever the device speaks.

```sh
cast play movie.mkv
```

No other flags: it finds the TV, picks the audio and subtitle tracks, resumes where
you stopped, transcodes only what the receiver cannot play, and adapts quality
to the link while it runs.

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

Almost every failure in this project came from forgetting that the second arrow
points inward. The advertised URL has to be routable **from the TV**. This is
not a Cast quirk: DLNA's fault code 716 means precisely the same thing, and it
is the first thing to suspect on either protocol.

That inversion is also why supporting a second protocol cost so little. Cast and
DLNA agree on almost nothing — one launches an application over a persistent TLS
connection and speaks protobuf, the other posts SOAP at a URL and keeps no
connection at all — but both are pull models, so probing the file, choosing the
tracks, extracting the subtitles and serving the media are the same work either
way. Only the last step differs.

There is deliberately **no adapter interface**. Two implementations of one thing
is a shape traced around the first; instead a tagged `Target` and an exhaustive
match make every site that acts on a device handle both, and the compiler says
so. A third protocol would make the right interface visible.

ffmpeg does the conversion. Video is stream-copied whenever the source is
already H.264 8-bit 4:2:0 at 1080p or below; only the audio is always
re-encoded, because Cast receivers reject AC-3 and E-AC-3 and never accept
Matroska as a container whatever the source was.

There are two ways to hand it over, and they fail differently:

| | progressive (default) | `--hls` |
|---|---|---|
| What is served | one continuous fragmented MP4 | a VOD playlist per quality, every segment addressable |
| Who picks the quality | we do, by measuring | the receiver does, from its own buffer |
| Changing quality | restart ffmpeg, reissue `LOAD` — a visible rebuffer | next segment comes from another variant |
| Seeking | restart ffmpeg at the new offset | the receiver seeks; nothing restarts |
| Cost when idle | nothing | nothing: segments are encoded only when requested |

HLS is the better design and is not yet the default, for one reason: the
progressive path has been watched end to end on a real television and HLS has
only been verified against an emulated one. See [Known gaps](#known-gaps).

## Install

Requires Node 22+ and ffmpeg on `PATH`.

```sh
npm install
npm run check       # typecheck, lint, architecture, codegen drift, tests
npm run build:cli   # a single-file binary at dist/cast.cjs
npm i -g .          # ...or install it as `cast`
```

This is an npm workspace. `npm run cast -- <args>` runs the CLI from source;
there is no build step in the development loop, because package names resolve to
each package's barrel through tsconfig paths. The bundle exists only so the tool
can be installed and run from anywhere.

## Usage

```sh
# Everything is optional
cast play movie.mkv

# What's on the network?
cast scan

# What's in the file, and what would be chosen?
cast streams movie.mkv

# Override any of it
cast play movie.mkv --device "Living Room" --audio 3 --subs 5 --seek 12:30

# Let the receiver choose the quality and do its own seeking
cast play movie.mkv --hls
```

| Flag | Meaning | Default |
|---|---|---|
| `--device <substring>` | Pick a device by name | the last one used, else the first found |
| `--ip <address>` | Device address, skipping discovery | — |
| `--audio <index>` | Audio stream index | first match for `CAST_AUDIO_LANGUAGES` |
| `--subs <index>` | Subtitle stream index, served as a WebVTT sidecar | preferred language, most cues |
| `--seek <time>` | Start position: `90`, `1:30` or `1:02:03` | where you stopped |
| `--hls` | Serve HLS instead of one continuous stream (Cast only) | off |

### Control

```sh
cast status                    # what is it playing?
cast toggle                    # pause if playing, resume if paused
cast pause / cast resume
cast seek --back 5:00          # also --forward and --to
cast volume --level 20
cast stop
```

These attach to the running session rather than launching a new one, so pausing
does not restart the film.

`seek` behaves differently depending on what is being served, and the difference
is not cosmetic. Under HLS every segment of the film is addressable, so the
receiver seeks by itself and nothing restarts. Progressively there is nothing to
seek *within* — a live pipe has no byte ranges — so `cast seek` asks the running
`cast play` to restart ffmpeg at the new offset.

That distinction was found by testing rather than reasoning: built on the Cast
`SEEK` command, `--forward` reported a new position while the film carried on
from the old one, because the receiver had quietly restarted the stream from its
beginning.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `CAST_PORT` | 8021 | Preferred local HTTP port; a free one is used if taken |
| `CAST_DEVICE_PORT` | 8009 | Cast control port |
| `CAST_ADVERTISE_HOST` | auto | Override the advertised LAN address |
| `CAST_AUDIO_BITRATE` | 128k | AAC bitrate |
| `CAST_AUDIO_LANGUAGES` | eng,und | Audio preference, best first |
| `CAST_SUBTITLE_LANGUAGES` | eng | Subtitle preference, best first |
| `CAST_DISCOVERY_TIMEOUT_MS` | 4000 | Per-sweep mDNS timeout |
| `CAST_DEVICE_IP` | — | Pin the device, skipping discovery |

## Failures are messages, not stack traces

Every expected failure is a domain error that renders itself, and bad input is
rejected by Schema before anything opens a socket:

```
$ cast status --ip 192.168.1.99
error: could not reach a Cast device at 192.168.1.99:8009 — check that it is
switched on and on this network (`cast scan` lists what is reachable)

$ cast play movie.mkv --ip 999.1.1.1
Invalid value for flag --ip: "999.1.1.1".
Expected: expected an IPv4 address such as 192.168.1.24
```

That first one took three separate fixes. The socket was handed to
`Socket.fromTransformStream` as a lazy effect, so the connection was deferred to
the first write and a write to a dead device never settled; the socket's run
fiber was forked with its failure discarded and ended the message queue
*cleanly*, so an unreachable device looked exactly like an idle one; and there
was no connect timeout at all, leaving TCP's own, in minutes. The symptom was a
command that printed nothing, hung, and exited 0.

## Adaptive quality (the progressive path)

Under `--hls` the receiver chooses, and none of this runs. Progressively,
quality adapts to the link automatically. The hard part is that **spare
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

Pin it with `CAST_*` config or extend the ladder in
`packages/quality/src/Ladder.ts`.

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

**Track metadata cannot be trusted, so it is not.** In the file this tool was
built for, ffprobe reports two indistinguishable Spanish subtitle tracks. Stream
4 is 24 cues of forced signage; stream 5 is 1670 lines of dialogue. The
container flags **4** as `default` and neither as `forced`, so the obvious
heuristic picks the signage.

The only signal that separates them is how many cues each holds, which means
reading the tracks — so that is what happens. `play` extracts the candidates in
the best matching language and keeps the one with the most cues; `streams` shows
the counts and marks what `play` would choose:

```
$ cast streams movie.mkv
     [4] subtitle subrip spa 24 cues [default]
  -> [5] subtitle subrip spa 1670 cues
     [6] subtitle subrip eng 1988 cues
```

## Layout

```
packages/
  domain/       branded scalars, typed errors, media and device models
  protocol/     Cast v2 wire format, message schemas, TLS transport, session,
                and the vendored cast_channel.proto it is generated from
  media/        ffmpeg invocations as typed values, WebVTT as a Schema codec
  quality/      ladder, signals (state → phase), controller (phase → action)
  dlna/         DLNA/UPnP: SSDP, SOAP, DIDL-Lite, and actions generated from
                the vendored service descriptions
  platform/     generic Node bridges: UDP for mDNS, http.createServer
  emulator/     devices, emulated well enough to test against
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
| `npm run lint` | 25 project rules |
| `npm run vocabulary:sync` | refetch the media vocabulary from Google (needs the network) |
| `npm run depcruise` | no cycles, Node builtins stay in `platform`/`protocol`, packages never import the app |
| `npm run codegen:check` | generated wire descriptors, media vocabulary and UPnP actions are not stale |
| `npm test` | 196 tests, in about a second |
| `npm run test:e2e` | 4 tests that run the built binary at emulated devices, Cast and DLNA |
| `npm run check` | all of the above — and the only thing CI runs |

The lint rules encode one idea: never hand-roll what Effect provides. `no-if`,
`no-try-catch`, `no-throw`, `no-await`, `no-timers`, `no-date-now`,
`no-process-env`, `no-console`, `no-json-parse`, `no-schema-sync`, `no-as-cast`,
`no-non-null`, `no-any` and more. `packages/platform/**`, `scripts/**` and tests
carry narrow, documented exemptions.

## Testing without a television

`packages/emulator` holds two devices. The Cast one serves the control channel over TLS and
then does the half that matters — pulls the media over HTTP exactly as a
receiver does, walking the master playlist to a variant and the variant to its
segments. A *device* rather than a service, because it owns its own listener and
there can be several at once.

```sh
npm test        # 112 tests, about a second
npm run test:e2e  # the built binary, run at an emulated device
```

The end-to-end tests run apart from the rest and one at a time: they spawn
processes, encode video and bind ports, and run beside the fast suite they
contended for all three — a suite that took five minutes and failed a test that
passes in ten seconds alone. They spawn `cast play` and assert on what the
device fetched.
It is the only test that exercises the inversion this tool is built around, and
it found two bugs in the emulator's first hour: a connection scope that closed
as soon as its handlers were attached, and replies addressed from the wrong
source id. It skips where ffmpeg or openssl are missing, so CI stays honest
without needing a media pipeline.

It also advertises over mDNS when asked, so `cast scan` finds it the way it
finds a real device — which is the only way to exercise discovery, the path
people actually use. It is off by default: advertising a Cast device on a real
network is not a private act.

The DLNA one is its HTTP sibling: it serves a device description, accepts SOAP
at the two control URLs, answers a proper `401 Invalid Action` fault for anything
it does not implement, and pulls the media when told to play.

What neither can tell you is whether a *particular* television accepts the
stream. That is why HLS is opt-in and why DLNA has not been near a real set.

## Generated, not transcribed

Three wire vocabularies come from their own sources rather than from someone
reading a document:

| Generated | From | Caught |
|---|---|---|
| Cast frame descriptors | Chromium's `cast_channel.proto` | field numbers that were right by transcription and would decay |
| Cast media vocabulary | `cast_receiver_framework.js`, the code a device runs | `HlsSegmentFormat` has eight values, not the four written by hand |
| UPnP actions | the `AVTransport:1` / `RenderingControl:1` SCPDs | argument order, which SOAP carries positionally |

That last one matters more than it sounds. `SetAVTransportURI` with its URI and
metadata the wrong way round is a well-formed request that a television accepts
and then ignores. The generated builders take a named record and emit the order
the service declared, so the mistake cannot be made.

`npm run codegen:check` fails when any of them is stale; `npm run vocabulary:sync`
refetches the Cast one from Google.

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
`Schema.decodeSync` in the WebVTT codec turning parse failures into defects, and
removing the `as` casts exposed an `Ipv4` brand that accepted
`999.999.999.999`.

## Known gaps

- **HLS is not the default.** It is the better design — the receiver picks the
  quality and does its own seeking, so neither costs a restart — and everything
  about it is verified except the one thing that matters most: no real
  television has played it. The emulated device walks the playlists and pulls
  the segments, which catches a malformed playlist but not a receiver that
  dislikes something about it. One confirmed session on a real device is all
  that stands between `--hls` and the default.
- **Progressive quality switches and seeks are visible.** Both restart ffmpeg
  and reissue `LOAD`. This is what HLS exists to fix.
- **The two processes talk through a file.** `cast seek` reaches the running
  `cast play` by writing a request into the state file, which the player polls
  once a second. Unglamorous, and a socket would be a great deal of machinery
  for one integer.
- **Effect has no TLS/TCP client socket.** `effect/unstable/socket` is
  WebSocket-only, so `packages/protocol/src/CastSocket.ts` wraps `node:tls` —
  but exposes it as a real `Socket.Socket`.
- **Effect has no UDP.** mDNS therefore uses `node:dgram` in
  `packages/platform/src/Mdns.ts`.
- **dependency-cruiser cannot see type-only imports here.** It does not yet
  support TypeScript 7, so it runs without the TS transpiler and `import type`
  edges are invisible to it. Value imports are checked. Found by deliberately
  breaking rules and watching two of them fail to fire.

## Documentation

| | |
|---|---|
| [`docs/direction.md`](docs/direction.md) | What this should become, and what to delete |
| [`docs/architecture.md`](docs/architecture.md) | Module map and the decisions worth explaining |
| [`docs/cast-protocol.md`](docs/cast-protocol.md) | The wire protocol as verified against Chromium |
