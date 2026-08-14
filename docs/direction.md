# Direction

What this should become, argued from the job rather than from the code that
exists. Written after the tool worked well enough to watch a film end to end,
which is the right moment to ask whether it is the right tool.

**Status:** everything argued for below in Tiers 1 and 2 is implemented. The
analysis is kept in its original tense — it is the reasoning, not a changelog —
and [What is left](#what-is-left) at the end says where things actually stand.

## The job

Not "cast a file to a device". The job is:

> I have a file and a screen. Put it on the screen, correctly, now.

*Correctly* is doing real work in that sentence. It means the audio in a
language I understand, subtitles that are dialogue rather than signage, no
stutter, and — if I already watched an hour of it — starting where I stopped.

## Measured against that job

The tool answered a narrower question than the one asked. Watching one film took
three commands and a wrong guess:

```sh
cast scan                                  # which device?
cast streams movie.mkv                     # which streams?
cast play movie.mkv --audio 3 --subs 5     # ...and the first --subs was wrong
```

The wrong guess is the interesting part. `cast streams` printed:

```
  [4] subtitle subrip spa
  [5] subtitle subrip spa
```

Two identical lines. Stream 4 is 24 cues of forced signage; stream 5 is 1670
lines of dialogue. The container flags **4** as `default` and neither as
`forced`, so the obvious heuristic is not merely unhelpful, it is actively
wrong. The only signal that separates them is the cue count, which the listing
does not show and a person cannot obtain without extracting the track.

So the tool currently delegates its hardest judgement — the one requiring
information only it can cheaply get — to the person using it, and its own help
text says so: *"Audio stream index (see `cast streams`)"*.

That is the gap. Everything below follows from closing it.

## Distillation, precisely

Yes, lean on distillation — with one clarification that changes what gets built.
**Distillation here means removing decisions, not removing features.** The
target is:

```sh
cast play movie.mkv
```

with no other flags, doing the right thing. Every existing flag survives as an
override. Four decisions move from the person to the tool:

| Decision | Rule | Cost |
|---|---|---|
| Which device | One found, use it; otherwise the last one used | a cache file |
| Which audio | First match against a language preference list | free, already probed |
| Which subtitles | Preferred language, then **most cues** among ties | free: extraction already counts them |
| Where to start | Resume the last position for this file | a cache file |

The subtitle rule is the one that matters, and it is cheap precisely because the
architecture already extracts cues once at startup. The count is a byproduct of
work already being done. A tool that knows 24 versus 1670 and still asks the
human to choose is withholding what it knows.

`cast streams` then stops being a required step and becomes what it should have
been: a diagnostic, for when the automatic choice was wrong. It should also
print cue counts and dispositions, so that a person overriding the choice has
the same information the tool used.

## The uncomfortable conclusion

The most sophisticated subsystem here is the one most likely to be deleted.

The adaptive quality controller — capacity inference from startup bursts, probes
that only a stall can refute, penalties that expire early when the link recovers
— exists for one reason: we push a **single** stream at a fixed bitrate, so the
receiver cannot choose, and we must infer spare capacity from indirect evidence.
We built an elaborate estimator for a quantity the receiver already knows: its
own buffer level.

HLS with variant playlists moves that decision to the side that has the
information. Adopting it would:

- remove the visible rebuffer on every quality switch, which is the one
  complaint a viewer can actually see;
- delete the reload queue, the `LOAD` reissue, the probe-and-hold logic, and
  most of `Signals` and `Controller`.

It is not free: it needs a segmenter, a playlist writer, and either several
encoders running at once or one producing several outputs — on a laptop, for a
single viewer, that is real CPU spent to prepare quality levels nobody may
watch. The current design spends nothing until it must switch. The startup-burst
measurement also remains useful under HLS for choosing where to *start*.

So: not yet, but the trigger is clear. **If visible quality switching becomes
the top complaint, HLS is the answer, and adopting it removes more code than it
adds.** That is worth writing down, because the natural instinct is to defend
the clever subsystem rather than notice that it is scaffolding around a missing
architecture.

## What has life beyond this repo

Three separable things, only one of which is unusual:

1. **`@castcli/protocol`** — a Cast v2 client that is Effect-native, generated
   from Chromium's own `cast_channel.proto`, and verified against the receiver
   framework Google ships. The existing Node libraries in this space are
   callback-based and largely unmaintained. This is the piece someone else could
   want.
2. **The quality controller** — interesting, and possibly obsoleted by the
   section above.
3. **The CLI** — the demonstration. Valuable to its user; not a product.

If anything here is ever published, it is (1), and the CLI is its example.

## What not to build

Scope discipline, recorded so it does not have to be re-argued:

- **Not a media server.** Jellyfin and Plex exist and are good. The pull model
  means going that way is rebuilding them, badly, and the job above says nothing
  about libraries, metadata, or users.
- **Not a GUI.** The job is one command.
- **Not a transcoding profile zoo.** The receiver's constraints are known and
  narrow; the correct number of knobs is close to zero, which is why quality is
  adaptive rather than configured.
- **Not multi-device groups or sync.** A different job with a different hard
  part (clock alignment), and not one anybody has asked for.

## Ordered plan

**Tier 1 — serves the job directly.** Done.

1. ~~Zero-flag defaults: device, audio, subtitles by the rules above.~~
2. ~~`cast seek`.~~ Served by reloading rather than by the receiver's `SEEK`,
   because a live pipe has no byte ranges: asked to jump, the receiver silently
   restarts the stream from its beginning instead.
3. ~~Remember position per file, and resume by default.~~
4. ~~`cast streams` shows cue counts and dispositions~~, and marks what `play`
   would choose.

**Tier 2 — durability.** Done. Splitting `Session.makeOver` from the socket was
what made this possible, and it immediately found a real bug: a media command
issued before the receiver reported a media session was silently discarded while
the caller printed "paused".

5. ~~Tests for `Session`, `CastSocket`, `Mdns` and the routes, against fakes
   rather than a real TV.~~
6. ~~CI running `npm run check`.~~
7. ~~An installable binary.~~ A single bundled file, because the workspace
   packages do not resolve outside the workspace.

**Tier 3 — architecture.** Still gated on the trigger named above.

8. HLS variant playlists, deleting most of the quality actuation.

## What is left

Everything above the line is done, which makes the remaining list short and
worth stating plainly:

- **HLS**, on the trigger — now covering both remaining visible defects, since a
  seek restarts the stream for exactly the same reason a quality switch does.
- **`cast streams` costs ~20 seconds** on a file with several subtitle tracks,
  because counting cues means extracting them. `play` is cheaper — it only reads
  one language — but the listing could cache what it learns.
