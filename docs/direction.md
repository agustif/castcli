# Direction

Why this tool exists and what remains.

## The job

Not "cast a file to a device". The job is:

> I have a file and a screen. Put it on the screen, correctly, now.

*Correctly* means: audio in a language I understand, subtitles that are dialogue rather than signage, no stutter, and starting where I stopped if I've watched part of it already.

## Removing decisions, not features

The target is `cast play movie.mkv` with no other flags. Four decisions moved from the person to the tool:

1. Which device
2. Which audio track
3. Which subtitles
4. Where to resume

Every flag (`--device`, `--audio`, `--subs`, `--seek`) exists as an override, not a requirement.

A tool that can distinguish 24 cues of signage from 1670 lines of dialogue (by reading the tracks) but still asks which to use is withholding what it knows.

## HLS: letting the receiver decide

The adaptive quality controller exists because we push a single stream at a fixed bitrate — the receiver can't choose, so we must infer spare capacity from indirect evidence (startup bursts, stalls, probes).

HLS moves that decision to the side that has the information. The receiver switches quality on segment boundaries and seeks by requesting different segments. Nothing restarts. Segments are encoded only when requested, so variants nobody watches cost nothing.

HLS is now the default. The progressive path still exists for files that can't be segmented (too small, no duration) or receivers that reject HLS.

## What not to build

- **Not a media server**: Jellyfin and Plex exist. The pull model means going that way rebuilds them, badly.
- **Not a GUI**: the job is one command.
- **Not a transcoding profile zoo**: the receiver's constraints are known and narrow. Quality is adaptive, not configured.
- **Not multi-device groups or sync**: a different job with a different hard part (clock alignment).

## The three protocols

Cast, DLNA, and AirPlay agree on almost nothing — Cast launches an application over TLS and speaks protobuf, DLNA posts SOAP, AirPlay speaks HTTP — but all three are pull models. The device fetches from us. That's why supporting three protocols cost so little: probing the file, choosing tracks, extracting subtitles, and serving media are the same work. Only the last step differs.

AirPlay 2 with HAP pairing is implemented: pair-setup (M1-M6), pair-verify (M1-M4), encrypted control channel (ChaCha20-Poly1305), MFi auth-setup (sender POST), play-queue, volume control, and URL handoff. The same media server, quality ladder, segment encoder, and subtitle handling used for Cast and DLNA serve AirPlay.

CLI pairing is fail-closed: pair-setup runs with a PIN, pair-verify runs before every play, and playback fails if pairing or verification fails. Pairing is stored by device ID (when available) with IP fallback.

The implementation is verified end-to-end against an emulated AirPlay device that requires pairing, decrypts encrypted control frames, and pulls the media URL.

## What remains

### Hardware testing

Three things wait on hardware:

1. **Cast HLS on a real TV**: HLS is the default and works with emulated devices. Real hardware would confirm it end-to-end.
2. **DLNA on a real TV**: The path is verified against an emulated renderer and has never met a real set.
3. **AirPlay on an Apple TV or third-party AirPlay TV**: The sender (pair-setup, pair-verify, encrypted control, play-queue, volume) is complete and verified against an emulated device. Hardware would confirm it works end-to-end.

### Unproven gap

One gap remains unproven in software:

- **mDNS discovery end-to-end** (draft PR #24): the e2e test currently uses `--ip` to bypass discovery.

Everything else that can be verified without hardware has been.
