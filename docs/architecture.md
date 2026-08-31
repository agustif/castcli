# Architecture

For contributors: how this codebase is organized and the patterns it uses.

## Package layout

```
packages/
  domain/       Branded scalars, domain errors, media and device models
  protocol/     Cast v2 wire format (generated from cast_channel.proto)
  media/        ffmpeg, HLS playlist generation, WebVTT codec
  quality/      Adaptive quality ladder and controller (progressive mode)
  dlna/         DLNA/UPnP: SSDP discovery, SOAP actions, renderer control
  airplay/      AirPlay: HAP pairing, crypto primitives, session management
  platform/     Node bridges (UDP for mDNS, HTTP server, subprocess spawner)
  emulator/     Emulated Cast, DLNA, and AirPlay devices for testing

apps/
  cli/          CLI commands, flags, media server routes

tools/
  oxlint-plugin/ Custom lint rules for Effect patterns
```

`domain` is the base: it imports no other workspace package, enforced by a lint rule.

## Dependency graph

```
                    ┌──────────────────────────────────────┐
                    │              apps/cli                │
                    │  play · scan · streams · status …    │
                    └──────────────┬───────────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────────┐
        │                          │                              │
┌───────▼─────────┐      ┌─────────▼─────────┐        ┌─────────▼─────────┐
│    protocol     │      │       media       │        │      quality      │
│    dlna         │      │  Ffmpeg · Hls     │        │ Controller        │
│    airplay      │      │  Vtt · Tracks     │        │ Signals · Ladder  │
└───────┬─────────┘      └─────────┬─────────┘        └─────────┬─────────┘
        │                          │                            │
        └──────────────┬───────────┴────────────────────────────┘
                       │
              ┌────────▼─────────┐        ┌──────────────────────┐
              │      domain      │        │       platform       │
              │ Brands · Errors  │        │  Mdns (udp)          │
              │ Rung · Media     │        │  HttpServer          │
              └──────────────────┘        └──────────────────────┘
```

## The pull model

Two independent channels to the device:

- **Control** — TLS 8009 (Cast), HTTP (DLNA/AirPlay), we connect outward
- **Data** — HTTP 8021, **the device connects to us** and pulls

The advertised URL must be routable from the TV. This is why the tool exists: VLC advertises a link-local IPv6 address with zone index (`%en0`) that's meaningless to the TV.

## Tagged `Target`, not adapter interfaces

Cast, DLNA, and AirPlay are represented as a tagged union:

```typescript
type Target = Data.TaggedEnum<{
  readonly Cast: { readonly device: CastDevice }
  readonly Dlna: { readonly renderer: DlnaDescription.Renderer; readonly location: string }
  readonly AirPlay: { readonly device: AirPlayDevice }
}>
```

Every site that acts on a device uses `Match.exhaustive`, so adding a fourth protocol is a compile error until every command handles it. No adapter interface to implement — the three protocols agree on almost nothing except the pull model, which belongs to the media server.

## Effect patterns

### Scopes own resources

`Ffmpeg.transcode` returns a scoped effect. Closing the scope kills the encoder. A seek or quality change is "close old scope, open new scope" — no bookkeeping, no leaked processes.

### Time is a service

The quality controller reads `Clock` and loops on a `Schedule`, never `Date.now()` or `setInterval`. This lets the entire controller run under `TestClock`, which matters because interesting behavior happens over minutes.

### Brands catch type confusion

`Ipv4`, `Port`, `VolumeLevel`, `Seconds`, `StreamIndex` — branded types prevent:

- Handing a device `999.999.999.999` (rejected at parse time by `Ipv4.make`)
- Treating volume percentage (0-100) as Cast volume level (0.0-1.0)
- Confusing stream indices with track IDs

`--ip not-an-ip` fails at argument parsing, not at `LOAD`.

### Errors carry causes

Every domain error is a `Schema.TaggedError` with cause preservation. `DeviceNotFoundError` knows what was searched for and what was found; `MediaProbeError` knows the path. Errors render themselves with full context.

### Signals and controller are separate

`Signals.phaseOf` is a pure function of state and clock: "what situation are we in?" Returns a tagged `Phase`.

`Controller` is a separate exhaustive match over `Phase`: "what to do about it?" No conditionals — adding a new phase is a compile error until every site handles it.

## Generated vocabularies

Three wire vocabularies come from their sources, not from transcription:

| Generated | From | Caught |
|---|---|---|
| Cast frame descriptors | `cast_channel.proto` | Field numbers that were right by luck and would decay |
| Cast media vocabulary | `cast_receiver_framework.js` (what devices run) | `HlsSegmentFormat` has 8 values, not the 4 written by hand |
| UPnP actions | `AVTransport:1` / `RenderingControl:1` SCPDs | Argument order (SOAP carries it positionally) |

`npm run codegen:check` fails when any is stale. `npm run vocabulary:sync` refetches Cast vocabulary from Google.

## Two processes, one socket

`cast play` and `cast seek` are separate processes. Control commands reach the running player via a unix domain socket (`ControlChannel`) with schema-validated request/response. The socket is created when `play` starts and removed when it stops.

## HLS and progressive, side by side

`/stream` serves a single continuous transcode. `/master.m3u8` and its variants serve HLS VOD. Both are served simultaneously because they fail differently — we choose quality for one, the receiver for the other. Serving both costs nothing: segments don't exist until requested.

HLS playlists are arithmetic over runtime, so they're pure functions (`media/Hls/Playlist`). Only the segment encoder touches ffmpeg, and it's scoped: a receiver that abandons mid-switch takes the encoder with it.

## Validation at boundaries

Every value is decoded at its boundary (CLI flags, ffprobe output, Cast messages, DLNA SOAP, AirPlay plist) and carries a brand afterward. `Option` for absence, never `null` or magic zero.

## Control flow via Effect, not primitives

The `oxlint` plugin enforces: never hand-roll what Effect provides.

| Forbidden | Use instead |
|---|---|
| `if`/`else` | `Match.value`, `Option.match`, `Effect.when` |
| `try`/`catch`, `throw` | `Effect.try`, `Schema.TaggedError` |
| `await`, raw `Promise` | `yield*`, `Effect.promise` |
| `setTimeout`, `Date.now()`, `Math.random()` | `Schedule`, `Clock`, `Random` |
| `process.env` | `Config` |
| `console.log` | `Console`, `Effect.log*` |
| `JSON.parse` | `Schema.fromJsonString` |
| `Schema.decodeSync` | `decodeEffect` (the `*Sync` forms throw) |
| `node:http`, `node:fs`, `fetch`, `node:child_process` | Effect equivalents |

`packages/platform/**` is exempt from Node-interop rules — confining that code is the point of the package.

## Architecture checks

`dependency-cruiser` enforces:

- No cycles
- Node builtins stay in `platform` and `protocol`
- Packages never import the app
- `domain` imports no other workspace package (also checked by lint, since tsconfig paths resolve before dependency-cruiser sees the import)

## What Effect doesn't cover

- **TLS/TCP client**: `effect/unstable/socket` is WebSocket-only. `protocol/CastSocket` bridges `node:tls` via `Duplex.toWeb()` into `Socket.fromTransformStream`.
- **Free port**: `platform/HttpServer.freePort` binds to zero and releases it.
- **TLS server**: The emulator uses `node:tls`, confined to `packages/emulator`.
- **UDP**: mDNS uses `node:dgram` in `packages/platform/Mdns`. Datagram callbacks can't run Effects, so they push to a `Queue` and a forked fiber folds packets into a `Ref`.

## Testing

- **Unit tests**: `vitest`, about 1 second for 624 tests
- **E2E tests**: Built binary run against emulated Cast, DLNA, and AirPlay devices. Spawn processes, bind ports, encode video. Run serially and separately from the fast suite.

`packages/emulator` holds three devices. Each serves its control channel and pulls media over HTTP like a real device. The Cast emulator can advertise via mDNS (off by default). The AirPlay emulator can require HAP pairing and decrypts encrypted control frames.

E2E tests exercise the inversion this tool is built around: the device pulls from us.
