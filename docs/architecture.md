# Architecture

## Shape of the thing

```
                    ┌──────────────────────────────────┐
                    │            bin/cast              │  effect/unstable/cli
                    │   play · scan · streams          │
                    └───────────────┬──────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────▼────────┐        ┌─────────▼─────────┐       ┌─────────▼─────────┐
│  Cast/Session  │        │   Server/Routes   │       │ Quality/Controller│
│  launch, load, │        │  /stream          │       │  ladder, probing, │
│  heartbeat     │        │  /subs.vtt        │       │  back-off         │
└───────┬────────┘        └─────────┬─────────┘       └─────────┬─────────┘
        │                           │                           │
┌───────▼────────┐        ┌─────────▼─────────┐       ┌─────────▼─────────┐
│ Platform/      │        │  Media/Ffmpeg     │       │  Quality/Signals  │
│ CastSocket     │        │  Args · Service   │       │  state → phase    │
│ (node:tls)     │        │  Media/Vtt/Codec  │       └───────────────────┘
└────────────────┘        └───────────────────┘
```

Two independent channels to the device, which is the thing to hold in mind:

- **control** — TLS 8009, we connect outward, length-prefixed protobuf;
- **data** — HTTP 8021, *the device connects to us* and pulls.

Almost every failure in this project came from forgetting that the second one is
inbound. The advertised URL has to be routable **from the TV**.

## Module map

| Module | Responsibility |
|---|---|
| `Domain/Brands` | Branded scalars: `Seconds`, `Bitrate`, `Height`, `StreamIndex`, `Ipv4`, `Port` |
| `Domain/Errors` | Every failure as a `Schema.TaggedError` |
| `Domain/Rung` | `Copy \| Encode` — a quality rung as a tagged union |
| `Domain/Media` | ffprobe output, decoded not trusted |
| `Domain/Device` | A discovered Cast device |
| `Cast/Protocol/Frame` | Protobuf framing, recursive parsers |
| `Cast/Protocol/Namespace` | Namespaces, message types, player states as literals |
| `Cast/Protocol/Messages` | Payload schemas + decoders |
| `Cast/Session` | Virtual connections, heartbeat, launch, media commands |
| `Media/Ffmpeg/Args` | ffmpeg invocations as typed values |
| `Media/Ffmpeg/Service` | probe, extract cues, transcode — all scoped |
| `Media/Vtt/Codec` | WebVTT as a `Schema` codec, plus `cutFrom` |
| `Quality/Ladder` | Building the rung ladder |
| `Quality/Signals` | State, thresholds, and `phaseOf` — *what situation are we in* |
| `Quality/Controller` | *What to do about it* — one exhaustive match |
| `Server/Routes` | The two endpoints the device pulls |
| `Platform/*` | The only Node-specific code |
| `Cli/*` | Schema-validated flags and time codes |

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

`src/Platform/**` is exempt from the Node-interop rules: confining that code to
one directory is the point of the directory.

Two of these caught real bugs in code I had already written — `no-schema-sync`
found `Schema.decodeSync` in the WebVTT codec turning parse failures into
defects, and `no-node-http` found `node:http` leaking into the CLI.

## What Effect does not cover

- **TLS/TCP client sockets.** `effect/unstable/socket` is WebSocket-only. But
  `Socket` itself is transport-agnostic, so `Platform/CastSocket` bridges
  `node:tls` through `Duplex.toWeb()` into `Socket.fromTransformStream` — the
  handshake is the only Node-specific part, and everything downstream consumes a
  real `Socket.Socket`.
- **UDP.** No datagram module at all, so mDNS uses `node:dgram`.
