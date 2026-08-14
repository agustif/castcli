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
implemented. A VOD playlist makes every segment of every variant addressable, so
the receiver switches quality on a segment boundary and seeks by asking for a
different segment. Nothing restarts. The objection at the time — that preparing
variants nobody watches burns CPU — turned out not to apply, because segments
are encoded only when requested; a thousand of them across six variants cost
nothing until someone asks for one.

It is not the default, for a reason that has nothing to do with the design: the
progressive path has been watched end to end on a real television and HLS has
only been verified against an emulated one. Both are served side by side and
`--hls` chooses. When a real device confirms it, the default flips and the
controller's actuation — the reload queue, the `LOAD` reissue, the
probe-and-hold logic — can go.

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

## What is left

- **One session on a real television**, after which `--hls` becomes the default
  and the quality controller's actuation can be deleted.
- **`cast streams` costs ~20 seconds** on a file with several subtitle tracks,
  because counting cues means extracting them. `play` is cheaper — it reads only
  one language — but the listing could cache what it learns.
