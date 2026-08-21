---
name: local-dev
description: How to bring the castcli sandbox to a working local dev environment — Node 22, ffmpeg, the effect version pin, and the verification gate
---

# local-dev

Record of the onboarding run on 2026-08-21. The sandbox snapshot
(`zmzdznjyijxkgysm0wl6:default`) already contains everything below; this file
exists so the state can be rebuilt if it is ever lost.

## What the dev stack needs

- **Node 22+** (repo requirement; CI pins 22). The sandbox image ships Node 20
  at `/usr/bin/node`, which is too old for some devDeps.
- **ffmpeg + ffprobe on PATH** — required by `play`, `streams` and the e2e
  tests (they fail, not skip, without it unless `CASTCLI_E2E_SKIP=1`).
- **openssl on PATH** — needed by the HLS e2e test.
- No database, no Redis, no other services. No required env vars.

## Environment setup (as performed)

```sh
# 1. Node 22 — untarred to ~/.local/opt/node22, symlinked into /usr/local/bin
#    (which shadows /usr/bin on PATH):
TARBALL=$(curl -s https://nodejs.org/dist/latest-v22.x/ | grep -o 'node-v22[0-9.]*-linux-x64.tar.xz' | head -1)
curl -sL -o /tmp/node22.tar.xz "https://nodejs.org/dist/latest-v22.x/$TARBALL"
mkdir -p ~/.local/opt && tar -xf /tmp/node22.tar.xz -C ~/.local/opt
mv ~/.local/opt/node-v22*-linux-x64 ~/.local/opt/node22
ln -sf ~/.local/opt/node22/bin/{node,npm,npx} /usr/local/bin/

# 2. ffmpeg/ffprobe — static build, same pattern:
curl -sL -o /tmp/ffmpeg.tar.xz https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz
mkdir -p ~/.local/opt/ffmpeg && tar -xf /tmp/ffmpeg.tar.xz -C ~/.local/opt/ffmpeg --strip-components=2
ln -sf ~/.local/opt/ffmpeg/{ffmpeg,ffprobe} /usr/local/bin/
```

## Dependency install — the important part

`npm ci` **fails on main**: `package-lock.json` predates the
`@castcli/airplay` and `@castcli/source` workspaces. And a plain
`npm install` is not enough either: the root `package.json` asks for
`effect: ^4.0.0-rc.109` (resolves to rc.111 today) while every workspace pins
exact `4.0.0-rc.109`, so npm nests a second copy and typecheck fails with
private-property identity errors between the two `effect` copies.

The working sequence (no tracked files are modified):

```sh
npm install --package-lock=false --no-save --no-audit --no-fund
npm install --package-lock=false --no-save --no-audit --no-fund \
  effect@4.0.0-rc.109 @effect/platform-node@4.0.0-rc.109 @effect/vitest@4.0.0-rc.109
```

The second command forces the root copies to the version the workspaces pin,
npm dedupes the nested copies away, and a single `effect` remains.

### Sandbox quirk: root-owned legacy `node_modules`

The sandbox image pre-installed `node_modules` as root; the `user` account
cannot delete or move those directories out of their parent (only in-place
renames work). They were renamed aside and are inert:

- `rootdeps-old/` (was the repo-root `node_modules`)
- `packages/*/.nm-old/`, `apps/cli/.nm-old/`, `tools/oxlint-plugin/.nm-old/`

`oxlint` scans dot-directories, so an **untracked `.eslintignore`** at the repo
root lists them (that file is sandbox-local — do not commit it). `tsc`,
`vitest` and `dependency-cruiser` never see them (include patterns /
`node_modules` excludes). If you ever reinstall from scratch, rename the
legacy dirs aside the same way before running `npm install`.

## Verification (all green, 2026-08-21)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 warnings, 0 errors |
| `npm run depcruise` | 0 errors (1 pre-existing `no-orphans` warning on `packages/airplay/src/PairVerify/Vocabulary.ts`, non-fatal) |
| `npm run codegen:check` | all four vocabularies in sync |
| `npm test` | 577/577 passed (89 files, ~10 s) |
| `npm run build:cli` | `dist/cast.cjs` (2.9 MB) |
| `npm run test:e2e` | 4/4 passed — Cast HLS walk, progressive pull, mDNS discovery, DLNA SSDP+pull |
| `node dist/cast.cjs --help / scan / streams <mkv>` | all behave as documented; `scan` exits 0 with no devices present |

`npm run check` (the CI gate, all of the above) exits 0.

## Primary flow to exercise after any rebuild

```sh
npm run build:cli
npm run test:e2e          # the built binary against emulated Cast + DLNA devices
node dist/cast.cjs streams <some-video.mkv>   # track listing + what play would choose
```

The e2e suite is the only test that exercises the inversion this tool is
built around (the receiver pulls from us), so it is the meaningful smoke test.
