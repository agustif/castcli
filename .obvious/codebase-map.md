# castcli — codebase map

npm workspaces monorepo. `packages/domain` sits at the base of the dependency
graph and imports no other workspace package. Apps never imported by packages.

| Path | What it is |
|---|---|
| `apps/cli/` | The `cast` command: subcommands, schema-validated flags, state file, the media server routes the receiver pulls from |
| `packages/domain/` | Branded scalars, typed errors, media and device models — the vocabulary everything else speaks |
| `packages/protocol/` | Google Cast v2: wire framing, message schemas, TLS transport, session; vendored `cast_channel.proto` it is generated from |
| `packages/media/` | ffmpeg invocations as typed values, WebVTT as a Schema codec, track selection |
| `packages/quality/` | Adaptive quality: rung ladder, signals (state → phase), controller (phase → action) |
| `packages/dlna/` | DLNA/UPnP: SSDP discovery, SOAP control, DIDL-Lite metadata; actions generated from vendored SCPDs |
| `packages/airplay/` | AirPlay: HomeKit (HAP) pairing — TLV8, SRP, Ed25519/X25519 crypto — and the sender protocol built on it |
| `packages/source/` | Read values out of first sources — RFCs, C headers — as Schema codecs |
| `packages/platform/` | The only Node-specific code: UDP (mDNS), `http.createServer`, TLS bridges |
| `packages/emulator/` | Emulated Cast and DLNA devices, good enough to test against (pulls media like a real receiver) |
| `tools/oxlint-plugin/` | The project's own lint rules ("never hand-roll what Effect provides") |
| `scripts/` | Codegen: protocol descriptors, receiver vocabulary, UPnP actions, HAP pairing tables |
| `docs/` | `architecture.md` (module map + decisions), `cast-protocol.md` (wire protocol as verified against Chromium), `airplay.md` (research), `direction.md`, dependency graph |
| `.github/workflows/check.yml` | CI: `npm ci` + `npm run check` + `npm run build:cli` on Node 22 with ffmpeg installed |
