# Direction

What this is for, argued from the job rather than from the code that exists.

Written after the tool worked well enough to watch a film end to end, which was
the right moment to ask whether it was the right tool. The plan that came out of
it has been carried out; what remains here is the reasoning worth keeping and a
short list of what is left.

## The job

Not "cast a file to a device". The job is:

> I have a file and a screen. Put it on the screen, correctly, now.

*Correctly* is doing real work in that sentence. It means the audio in a
language I understand, subtitles that are dialogue rather than signage, no
stutter, and — if I already watched an hour of it — starting where I stopped.

## Distillation means removing decisions, not features

Watching one film used to take three commands and a wrong guess:

```sh
cast scan                                  # which device?
cast streams movie.mkv                     # which streams?
cast play movie.mkv --audio 3 --subs 5     # ...and the first --subs was wrong
```

The wrong guess is the instructive part. `cast streams` printed two identical
lines for two Spanish subtitle tracks; one is 24 cues of forced signage, the
other 1670 lines of dialogue, and the container flags the *signage* as default.
The only signal that separates them is the cue count, which means reading the
tracks — work only the tool can cheaply do, and which it was asking a person to
do instead.

So the target became `cast play movie.mkv` with nothing else, every flag
surviving as an override. Four decisions moved from the person to the tool:
which device, which audio, which subtitles, where to resume. `cast streams`
stopped being a required step and became a diagnostic that shows cue counts and
marks what `play` would choose.

The general form: **a tool that knows 24 versus 1670 and still asks is
withholding what it knows.**

## The uncomfortable conclusion, and what came of it

The most sophisticated subsystem here was the one most likely to be deleted.

The adaptive quality controller — capacity inference from startup bursts, probes
that only a stall can refute, penalties that expire early when the link recovers
— exists for one reason: we push a **single** stream at a fixed bitrate, so the
receiver cannot choose and we must infer spare capacity from indirect evidence.
An elaborate estimator for a quantity the receiver already knows: its own buffer
level.

HLS moves that decision to the side that has the information, and it is now
implemented and the default. A VOD playlist makes every segment of every variant addressable, so
the receiver switches quality on a segment boundary and seeks by asking for a
different segment. Nothing restarts. The objection at the time — that preparing
variants nobody watches burns CPU — turned out not to apply, because segments
are encoded only when requested; a thousand of them across six variants cost
nothing until someone asks for one.

The progressive path still exists for files that cannot be segmented (too small, no duration) or
for receivers that reject HLS, selected with `--progressive`. The
controller's actuation — the reload queue, the `LOAD` reissue, the
probe-and-hold logic — remains for progressive-mode only.

## Testing the inversion

Everything about serving a film to a Cast device is inverted: the device fetches
from us. A test of what we *send* therefore checks the easy half, which is why
`packages/emulator` exists — a device that serves the control channel and then
really does pull the playlists and segments over HTTP.

It is a **device**, not a service: it owns its own TLS listener and there can be
several at once. That distinction matters if the emulator is ever lifted
somewhere more general. An HTTP-API emulator's plugin contract — register routes
on a shared app — cannot express a thing that listens on its own port and acts
as a client.

## What has life beyond this repo

1. **`@castcli/protocol`** — a Cast v2 client that is Effect-native, generated
   from Chromium's `cast_channel.proto` and from the receiver framework Google
   ships. The existing Node libraries in this space are callback-based and
   largely unmaintained.
2. **`@castcli/emulator`** — a Cast device to test against, which as far as I
   can tell does not otherwise exist.
3. **The CLI** — the demonstration. Valuable to its user; not a product.

## What not to build

Recorded so it does not have to be re-argued:

- **Not a media server.** Jellyfin and Plex exist and are good. The pull model
  means going that way is rebuilding them, badly, and the job above says nothing
  about libraries, metadata, or users.
- **Not a GUI.** The job is one command.
- **Not a transcoding profile zoo.** The receiver's constraints are known and
  narrow; the correct number of knobs is close to zero, which is why quality is
  adaptive rather than configured.
- **Not multi-device groups or sync.** A different job with a different hard
  part (clock alignment), and not one anybody has asked for.

## The third protocol

AirPlay was researched, and the full pull/URL-handoff path has been implemented
and verified against an emulated device. The cryptographic infrastructure for
HomeKit Accessory Protocol pairing (PairSetup/PairVerify) exists: SRP6a,
Ed25519, X25519, ChaCha20-Poly1305, HKDF, and TLV8 encoding all sit in
`packages/airplay` and are tested.

The sender protocol — mDNS `_airplay._tcp` discovery, HTTP control (`/play`,
`/rate`, `/scrub`, `/stop`, `/playback-info`), and the emulator that pulls
media — is complete. Integration into the CLI (`scan`, `play`, `status`,
`pause`, `resume`, `seek`, `stop`) works the same way it does for Cast and DLNA.

The pairing handshake is **not wired into the session**, because modern Apple
TVs require it and testing that path requires hardware. The pieces exist;
connecting them is bounded work once a device can validate the result. The
reasoning for this is in [`airplay.md`](airplay.md): the legacy unauthenticated
endpoints work with emulators and may work with some real devices (third-party
TVs, pre-tvOS 10.2 Apple TVs), but current Apple TVs demand a full AirPlay 2
session. Which path a given device accepts is settled by trying it. The `playQueue`
endpoint (`POST /command` with `insertPlayQueueItem`) exists in the sender Session
but pair-verify is not yet called from Session — the emulator implements pair-verify
and can require it, but the sender does not yet invoke it.

Mirroring (push-model H.264 encoding) is **deliberately not built**. It inverts
the pull model that lets Cast, DLNA, and AirPlay share the media server, quality
ladder, segment encoder, and subtitle handling.

## What is left

**Hardware to test against.** Three things wait on it and nothing else:

- **One Cast session with HLS on a real television.** HLS is already the default in
  software and works with emulated devices. Real Cast hardware would confirm it end-to-end.
  After that, the quality controller's actuation (reload queue, `LOAD` reissue,
  probe-and-hold logic) can be removed from progressive mode since HLS handles quality
  switching.
- **One DLNA television.** The whole path is verified against an emulated
  renderer and has never met a real set.
- **An Apple TV or Xiaomi/Samsung/LG AirPlay TV**, to test whether the
  implemented sender works with that device. The software is complete for the
  unauthenticated path. For modern Apple TVs, the final step is wiring pair-verify
  (which exists in the emulator) into the sender Session. If binary plist is required
  for `/play` (instead of the query-string contract currently used), that is a bounded
  addition.

Everything that can be verified without a device has been.
