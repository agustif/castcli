# castcli

Stream a local video file to a television from the command line — Google Cast
or DLNA, whichever the device speaks. Written to work around a VLC bug (it
advertises an unroutable link-local IPv6 URL to the TV; `cast` advertises an
explicit LAN IPv4 address instead).

## Stack

- **TypeScript**, strict + `exactOptionalPropertyTypes`, ESM, Node 22+
- **Effect 4.0.0-rc.109** (`effect`, `@effect/platform-node`, `@effect/vitest`) — all async/error handling goes through Effect; lint rules forbid the hand-rolled versions (`no-if`, `no-try-catch`, `no-await`, `no-console`, `no-process-env`, …)
- **npm workspaces** monorepo: `packages/*`, `apps/*`, `tools/*` — package names resolve through tsconfig paths, no build step in the dev loop
- Tooling: `tsc` (typecheck), `oxlint` (project rules in `tools/oxlint-plugin`), `vitest`, `dependency-cruiser`, `esbuild` (bundle only)
- **ffmpeg/ffprobe must be on PATH** for `play`, `streams` and the e2e tests
- No database, no long-running server. It is a CLI that binds an HTTP server on
  demand (default port 8021; picks a free one if taken) which the receiver
  pulls media from. Cast control channel is TLS on 8009.

## Commands

| Command | Purpose |
|---|---|
| `npm run cast -- <args>` | run the CLI from source (`npm run cast -- scan`) |
| `node dist/cast.cjs <args>` | run the built single-file binary |
| `npm run check` | **the full gate** — typecheck, lint, depcruise, codegen drift, unit + e2e tests; the only thing CI runs |
| `npm test` | unit tests only (fast, ~10 s) |
| `npm run test:e2e` | builds the binary, runs it at emulated Cast/DLNA devices |
| `npm run build:cli` | bundle to `dist/cast.cjs` |
| `npm run codegen:check` | generated wire descriptors / vocabularies not stale |
| `npm run vocabulary:sync` | refetch the Cast media vocabulary from Google (needs network) |

CLI subcommands: `play`, `scan`, `streams`, `status`, `pause`, `resume`,
`toggle`, `seek`, `volume`, `stop`. `cast <cmd> --help` for flags.

## Environment variables (all optional, safe defaults)

`CAST_PORT` (8021), `CAST_DEVICE_PORT` (8009), `CAST_ADVERTISE_HOST` (auto),
`CAST_AUDIO_BITRATE` (128k), `CAST_AUDIO_LANGUAGES` (eng,und),
`CAST_SUBTITLE_LANGUAGES` (eng), `CAST_DISCOVERY_TIMEOUT_MS` (4000),
`CAST_DEVICE_IP` (pin device, skips discovery).

## Codebase map

See [codebase-map.md](codebase-map.md). Reading order for orientation:
`README.md` → `docs/architecture.md` → `docs/direction.md`.

## Local verification summary

Verified 2026-08-21 in the repo sandbox (see
[skills/local-dev/SKILL.md](skills/local-dev/SKILL.md) for how to reproduce):

- `npm run check` — exit 0: typecheck clean, lint 0/0, depcruise 0 errors
  (1 pre-existing `no-orphans` warning, non-fatal), codegen in sync,
  **577 unit tests + 4 e2e tests all passing**
- `node dist/cast.cjs --help`, `scan`, `streams <real .mkv>` exercised
  manually; `scan` exits cleanly on a network with no devices; the
  unreachable-device error path renders the documented domain error
- e2e evidence: the built binary discovers an emulated Cast device over mDNS,
  serves both HLS and progressive streams the emulator pulls, and drives an
  emulated DLNA renderer over SSDP/SOAP

## Sandbox snapshot

- Template: `zmzdznjyijxkgysm0wl6:default`, captured 2026-08-21T18:02:10Z
- Contains: Node v22.23.2 (`~/.local/opt/node22`, symlinked into
  `/usr/local/bin`), static ffmpeg/ffprobe (`~/.local/opt/ffmpeg`), a working
  `node_modules` (single `effect@4.0.0-rc.109`), and `dist/cast.cjs`

## Conventions that matter

- `packages/domain` imports no workspace package; Node builtins live only in
  `platform`/`protocol`/`emulator`/`dlna` (+ `scripts`, `tools`) — enforced by
  lint + depcruise
- Values are decoded at the boundary and branded (`Ipv4`, `Port`, …); absence
  is `Option`, never `null` or a magic zero
- No adapter interface between Cast and DLNA: a tagged `Target` and an
  exhaustive match; a third protocol would make the right interface visible
- Three wire vocabularies are generated, not transcribed; `codegen:check`
  fails when they drift

## Known issues (verified, not assumed)

1. `npm ci` fails on `main`: `package-lock.json` is stale — it predates the
   `@castcli/airplay` and `@castcli/source` workspaces, so CI on `main` is red
   at the install step. Fixing it means regenerating the lockfile (out of
   scope for the setup PR).
2. A naive fresh `npm install` resolves the root's `^4.0.0-rc.109` to
   `rc.111` while every workspace pins exact `rc.109` — two physical copies
   of `effect` break typecheck with private-property identity errors. The
   snapshot's `node_modules` is already correct; if you must reinstall, follow
   [skills/local-dev/SKILL.md](skills/local-dev/SKILL.md).
