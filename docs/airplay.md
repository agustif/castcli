# AirPlay: researched, and not built

The tool speaks Cast and DLNA. AirPlay was the obvious third, and the question
that started this project — *why does VLC fail to reach my chromecast/airplay* —
named it explicitly. This is why it is not here.

Researched 2026-08-14. Where a claim is verified from source it says so; where
it is community consensus or inference, it says that instead.

## What fits

AirPlay video is a **pull model**, like the other two. The sender does not push
pixels: it hands over a URL and the device fetches it. The control surface is
plainer than DLNA — no SOAP, no DIDL:

| | |
|---|---|
| `POST /play` | `Content-Location` plus `Start-Position`, as a binary plist |
| `POST /scrub?position=` | seek |
| `POST /rate?value=` | `0` pauses, `1` resumes |
| `POST /stop` | stop |
| `GET /playback-info` | duration, position, rate, buffering, seekable ranges |

Discovery is mDNS `_airplay._tcp` on port 7000 — the same machinery already
written for Cast. Feature bit 0 is "video supported" and bit 4 is "http live
streaming supported", so a device announces whether it will take the HLS this
tool already serves.

On paper that is a smaller job than DLNA was.

## What does not

**`POST /play` no longer starts video on a current Apple TV.** Modern receivers
drive playback through a play queue: `POST /command` carrying
`insertPlayQueueItem`, over a type-130 stream registered with a specific client
UUID, and **PTP timing is mandatory** — with NTP the session collapses after
about twenty-seven seconds.

Three independent lines of evidence, which is why this is stated flatly:

1. pyatv's own pull request #2899 (open, unmerged, 2026-07-29) says it: *"pyatv
   sends POST /play, which modern receivers no longer use for video."*
2. An unrelated project, VioletRelay, independently arrived at the same
   `POST /command` shape and the *identical* reverse-engineered client UUID.
3. Apple's shipped framework symbols corroborate it — `insertPlayQueueItem`
   appears in dumps of `AirPlaySender.framework` and `MediaToolbox`.

Two 2026 projects still ship the classic `/play` path. Neither documents a
single successful Apple TV test, and the one hardware note in either is a Sony
set answering 404.

**Pairing is unavoidable.** Since tvOS 10.2 a device demands authentication, and
AirPlay 2 requires HAP: SRP6a, Ed25519, Curve25519, HKDF, and ChaCha20-Poly1305
for every subsequent frame. That is real cryptography, though all of it is
standardised and none of it is Apple-proprietary.

**FairPlay, however, is not needed.** This is the one piece of good news and it
is worth recording precisely, because the ecosystem blurs it: `/fp-setup` gates
*mirroring* and the audio key, not URL handoff. pyatv's sender path contains no
FairPlay at all; UxPlay's HTTP video path returns 421 to `/fp-setup2` and serves
HLS anyway. Mirroring would have meant reverse-engineered white-box crypto or an
MFi hardware module. Handing over a URL does not.

## Why it is not built

Three reasons, in order of weight.

**There is no first source.** Cast is generated from Chromium's
`cast_channel.proto` and from the enum tables in the framework Google ships;
DLNA is generated from the standardised SCPD service descriptions. AirPlay has
neither. What exists is a community wiki of reverse-engineered notes, and the
part that actually matters for a modern device — the play-queue command shape —
exists in exactly two unmerged, undemonstrated implementations. Everything would
be transcription, of a moving target, which is the practice this project has
spent its time removing.

**The demonstrated path is the wrong shape.** The only AirPlay video that is
provably working against 2021-2022 Apple TV hardware today is *mirroring*: encode
H.264 locally and push it over a keyed channel. That inverts the model
everything here is built on. The media server, the quality ladder, the segment
encoder and the subtitle handling all exist because the device pulls. A
mirroring sender would share none of it.

**It cannot be finished without the hardware.** The deciding experiment is an
hour with a real Apple TV: does the legacy `/play` still work on it, or is the
play queue mandatory. Without that, one would be building against a guess — and
this project's whole method has been to test against something, even if that
meant writing the something.

## What would change the decision

- **An Apple TV to test against.** If legacy `/play` still works there, the
  media path is perhaps a day's work on top of the HLS already served, and the
  cost collapses to pairing alone.
- **An AirPlay-compatible television** (Samsung, LG, Sony, Vizio) rather than an
  Apple TV. These are a different firmware lineage and may well accept the
  simple path; nobody has published a straight answer.
- **pyatv #2899 merging**, which would make the play-queue shape a maintained
  reference rather than a draft.

Until one of those, the honest position is that AirPlay is a month of
reverse-engineering with a real chance of not working at the end, against DLNA's
afternoon.
