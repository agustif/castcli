# Architecture

## Shape of the thing

```
                    ┌──────────────────────────────────────┐
                    │              apps/cli                │  effect/unstable/cli
                    │  play · scan · streams · status …    │
                    └──────────────────┬───────────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
┌───────▼─────────┐          ┌─────────▼─────────┐          ┌─────────▼─────────┐
│    protocol     │          │       media       │          │      quality      │
│ Session · Frame │          │  Ffmpeg · Vtt     │          │ Controller        │
│ CastSocket(tls) │          │                   │          │ Signals · Ladder  │
└───────┬─────────┘          └─────────┬─────────┘          └─────────┬─────────┘
        │                              │                              │
        └──────────────┬───────────────┴──────────────────────────────┘
                       │
              ┌────────▼─────────┐        ┌──────────────────────┐
              │      domain      │        │       platform       │
              │ Brands · Errors  │        │  Mdns (udp)          │
              │ Rung · Media     │        │  HttpServer          │
              └──────────────────┘        └──────────────────────┘
```

`domain` is the base: it imports no other workspace package, so nothing it
depends on becomes a dependency of everything else.

Two independent channels to the device, which is the thing to hold in mind:

- **control** — TLS 8009, we connect outward, length-prefixed protobuf;
- **data** — HTTP 8021, *the device connects to us* and pulls.

Almost every failure in this project came from forgetting that the second one is
inbound. The advertised URL has to be routable **from the TV**.

## Module map

| Package | Module | Responsibility |
|---|---|---|
| `domain` | `Brands` | Branded scalars, constructed through `.make`/`.makeOption`/`.makeEffect` |
| `domain` | `Errors` | Every failure as a `Schema.TaggedError`, causes preserved |
| `domain` | `Rung` | `Copy \| Encode` — a quality rung as a tagged union |
| `domain` | `Media` | ffprobe output, decoded rather than trusted |
| `domain` | `Device` | A discovered Cast device |
| `protocol` | `Frame` | Protobuf framing, descriptors generated from the `.proto` |
| `protocol` | `GeneratedVocabulary` | Literal sets generated from the framework devices run |
| `protocol` | `Namespace` | Namespaces, message types, player states, media commands |
| `protocol` | `Messages` | Payload schemas; only the decoders are exported |
| `protocol` | `Media` | LOAD/track schemas, from the published Cast reference |
| `protocol` | `CastSocket` | TLS transport, as an Effect `Socket` |
| `protocol` | `Session` | Virtual connections, heartbeat, launch, media commands |
| `media` | `Ffmpeg/Args` | ffmpeg invocations as typed values |
| `media` | `Ffmpeg/Service` | probe, extract cues, transcode — all scoped |
| `media` | `Vtt/Codec` | WebVTT as a `Schema` codec, plus `cutFrom` |
| `media` | `Tracks/Select` | Which audio and subtitle track to play, and why |
| `media` | `Hls/Playlist` | Master and media playlists as values |
| `quality` | `Ladder` | Building the rung ladder |
| `quality` | `Signals` | State, thresholds, and `phaseOf` — *what situation are we in* |
| `quality` | `Controller` | *What to do about it* — one exhaustive match |
| `platform` | `Mdns`, `HttpServer` | The generic Node bridges |
| `emulator` | `Device`, `Certificate` | A Cast device to test against |

There is a second implementation of the same idea, in plain TypeScript, as
`@emulators/cast` on the `devices-and-google-cast` branch of a fork of
vercel-labs/emulate. The duplication is deliberate: this one is Effect-native
and wired into this suite, that one belongs to a toolchain with no Effect in it
and serves a different audience. The protocol both speak is the part that must
not drift, and it is pinned by tests on both sides.
| `cli` | `Server/Routes` | The two endpoints the device pulls |
| `cli` | `Cli/*` | Schema-validated flags, time codes, control commands |
| `cli` | `State` | What is remembered between invocations, and never load bearing |

## Decisions worth explaining

### Signals and Controller are separate

Deciding *what situation we are in* is a pure function of state and the clock
(`Signals.phaseOf`), returning a tagged `Phase`. Acting on it is a separate
exhaustive match. The payoff is that the acting half has no conditionals at all,
and adding a new situation is a compile error until every site handles it.

### Scopes own processes

`Ffmpeg.transcode` is a scoped effect. Closing the scope kills the encoder, so a
seek or a rung change is "close the old scope, open a new one" rather than
bookkeeping a `Set` of child processes and remembering to `SIGKILL` them. The
original JavaScript version had exactly that bookkeeping, and leaked encoders.

### Time is a service

The controller reads `Clock` and loops on a `Schedule`, never `Date.now()` or
`setInterval`. Thresholds are `Duration` values, so the unit is in the type. The
whole controller can therefore be driven by `TestClock` — which matters, because
its interesting behaviour happens over minutes.

### Track selection is an effect, not a lookup

Choosing a subtitle track needs information the container does not carry
honestly: in the release this was built against, the 24-cue forced-signage track
is flagged `default` and the 1670-line dialogue track is flagged nothing. Only
the cue count separates them, and obtaining it means extracting the track — so
`chooseAudio` is a pure function while `chooseSubtitle` is an effect that reads
candidates in one language and keeps the richest.

`bestSubtitle` is the pure ranking underneath both, so `cast streams` can mark
the track `cast play` would pick rather than reimplementing the guess.

### The two processes share a file, not a socket

`cast seek` runs in a different process from `cast play`, and needs two things
from it: where the running stream starts, and — when the target is before that
point — someone to issue a fresh `LOAD`. Both go through the state file, which
the player polls once a second. A socket would be better engineering and much
more machinery for one integer.

### Two presentations, one server

`/stream` is a single continuous transcode; `/master.m3u8` and its variants are
an HLS VOD presentation of the same file. They are served side by side because
they fail differently — we choose the quality for one, the receiver chooses for
the other — and serving both costs nothing, since a segment does not exist until
it is requested.

The HLS playlist is arithmetic over the running time, so it is a pure function
and lives in `media/Hls/Playlist`. Only the segment encoder touches ffmpeg, and
it is scoped like every other process here: a receiver that abandons a request
mid-switch takes the encoder with it.

### The vocabulary is generated, not transcribed

Player states, stream types, HLS segment formats and track kinds come from
`cast_receiver_framework.js` — the code a Cast device actually runs — via
`scripts/extract-receiver-vocabulary.ts`. Its enums survive minification as
object literals keyed by constant name, so they can be recovered and diffed.

Two vocabularies are deliberately wider than what is generated, each documented
at the point it is widened: `PlayerState` also accepts `LOADING` and
`StreamType` also accepts `OTHER`, because rejecting a word a device might send
discards the whole message rather than the word.

The extractor refuses to guess. Asked for `PlayerState` it found two tables with
the same key set — the media player's, in caps, and the receiver application's,
in lowercase — and stopped rather than binding the wrong one.

### Errors carry causes

`Schema.Defect()` preserves the underlying failure instead of flattening it to a
string. `MediaProbeError` knows the path; `DeviceNotFoundError` knows what it
searched for and what it found, and renders that itself.

### Brands catch the bug that started this

`Ipv4` exists because handing a device an unroutable address is the failure this
whole tool works around. Making the type refuse anything that is not a dotted
quad moves that class of bug to compile time, and `--ip not-an-ip` now fails at
argument parsing rather than at `LOAD`.

### ffmpeg arguments are values

`Media/Ffmpeg/Args` models each option as a variant with a `render` function and
closed literal sets for codecs, muxers and flags. A flat `Array<string>` is a
wire protocol to another program with none of the safety: a typo in `-movflags`
is accepted silently, positional rules (input seeking must precede `-i`) are
invisible, and nothing stops a bitrate landing where a codec belongs.

## Guardrails

`oxlint` with a custom plugin written in Effect (`effect-oxlint`) enforces the
project's one rule — never hand-roll what Effect provides:

| Rule | Instead use |
|---|---|
| `no-if` | `Match.value` / `Option.match` / `Effect.when` |
| `no-try-catch`, `no-throw` | `Effect.try`, `Schema.TaggedError` |
| `no-await`, `no-promise` | `yield*`, `Effect.callback` |
| `no-timers`, `no-date-now`, `no-math-random` | `Schedule`, `Clock`, `Random` |
| `no-process-env` | `Config` |
| `no-console` | `Console`, `Effect.log*` |
| `no-json-parse` | `Schema.fromJsonString` |
| `no-schema-sync` | `decodeEffect` — the `*Sync` forms throw, making a typed failure a defect |
| `no-run-sync`, `no-swallowed-errors`, `no-or-die` | keep the fiber and the error channel intact |
| `no-node-http`, `no-node-fs`, `no-fetch`, `no-node-child-process` | the Effect equivalents |

`packages/platform/**` is exempt from the Node-interop rules: confining that
code to one package is the point of the package.

Architecture is checked separately by dependency-cruiser — no cycles, Node
builtins confined, packages never importing the app. One rule it *cannot*
enforce lives in the lint plugin instead: `packages/domain` importing another
workspace package resolves through tsconfig paths but is not a declared
dependency, so dependency-cruiser drops the edge rather than reporting it.

Two of these caught real bugs in code I had already written — `no-schema-sync`
found `Schema.decodeSync` in the WebVTT codec turning parse failures into
defects, and `no-node-http` found `node:http` leaking into the CLI.

## What Effect does not cover

- **TLS/TCP client sockets.** `effect/unstable/socket` is WebSocket-only. But
  `Socket` itself is transport-agnostic, so `protocol/CastSocket` bridges
  `node:tls` through `Duplex.toWeb()` into `Socket.fromTransformStream` — the
  handshake is the only Node-specific part, and everything downstream consumes a
  real `Socket.Socket`.
- **A free port.** `platform/HttpServer.freePort` binds to zero and lets go,
  because the configured port is a preference: the receiver is told which URL to
  pull, so any port works, and something else on the machine holding 8021 should
  not stop a film.
- **A TLS server.** The emulator listens with `node:tls`, which is the same
  gap as the client side and confined the same way, to one package.
- **UDP.** No datagram module at all, so mDNS uses `node:dgram`. The datagram
  callback cannot run an Effect, so it hands packets to a `Queue` and a forked
  fiber folds them into a `Ref` — the same shape `CastSocket` uses.
