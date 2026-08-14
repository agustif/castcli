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
written for Cast. A device announces its capabilities as a 64-bit `features`
bitmask in its TXT record, and whether it will play video is `bit 0 || bit 49`.

That disjunction is not pedantry. Decoding the TXT records of twelve real
devices shows the two halves of the world use different bits: **every Apple TV
sets bit 0 and clears 49; every third-party set — Roku, Samsung, LG — sets 49
and clears 0.** Checking either alone silently excludes half of them, and that
has bitten a real project: pyatv's author read an LG's mask against a community
table with no row 49 and concluded video was unsupported, while pyatv's own
runtime check said otherwise.

Whether *pairing* is required is a different field again — `flags`, where bit 3
is PIN mode, bit 7 password required and bit 9 pair-PIN. Capability and
permission are separate questions and reading one for the other is a
well-travelled mistake.

On paper that is a smaller job than DLNA was.

## What does not

**A bare `POST /play` does not start video on a current Apple TV.** Two
investigations reached slightly different accounts of why, and the difference is
worth keeping rather than smoothing over.

The first: modern receivers drive playback through a play queue — `POST /command`
carrying `insertPlayQueueItem`, over a type-130 stream registered with a
specific client UUID, with **PTP timing mandatory**; under NTP the session
collapses after about twenty-seven seconds.

The second, which is better evidenced and less dramatic: `/play` still works,
but only inside a full AirPlay-2 session — pair-verify, `SETUP`, an event
channel, `RECORD` — after which it starts **paused** and needs
`POST /rate?value=1.0`. pyatv's author put it plainly when he fixed it in 2023:
*"The play_url method has been broken for a very long time as I believed Apple
wasn't maintaining the underlying functionality anymore. They do, but an AirPlay
session must be established for it to work now."* The symptom without it is
exactly what people report: the screen goes black, shows a spinner, and returns
to the home screen after four seconds.

Either way the conclusion is the same — the simple endpoint is not the whole
protocol — but the second account means the work is "establish a session", not
"reverse-engineer a play queue", and that is a materially smaller thing. Which
one is true for a given device is settled by trying it.

The play-queue account rests on three independent lines: pyatv's own unmerged
pull request #2899, which states that *"modern receivers no longer use [POST
/play] for video"*; an unrelated project arriving at the same `POST /command`
shape and the *identical* reverse-engineered client UUID; and Apple's shipped
framework symbols, where `insertPlayQueueItem` appears in dumps of
`AirPlaySender.framework`.

Against that, two projects shipping in 2026 still use the classic path. Neither
documents a single successful Apple TV test, which is the point: nobody has
published a straight answer, and the disagreement is itself the finding.

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

**There is no first source worth generating from.** This is a weaker claim than
"no machine-readable table exists", and the difference matters, so it is worth
being precise.

There is no JSON, YAML or TOML of the feature bits anywhere. What exists is: one
CSV and one markdown table, both unlicensed; five language enums, of which
pyatv's (MIT) and goplay2's (Apache-2.0) are usable; and Apple's own MFi SDK C
header, which is the only authoritative artifact and is leaked proprietary
source that must not be vendored.

The four community tables **materially disagree** at bits 26, 30, 38 and 48, and
downstream copies introduce fresh errors of their own — one Rust port puts
`VideoVolumeControl` at bit 6 when it is bit 3. So generating from the licensed
enums would mean vendoring a table known to be wrong in specific places and
hand-authoring a correction overlay against a header we may not copy. That is
not the same kind of act as generating from Chromium's `.proto` or a UPnP
service description, where the source *is* the contract. It is transcription
with extra steps, of a target that moves.

The one genuinely machine-readable, authoritative, freely licensed artifact in
the whole area is IANA's service-name registry, which gives the service types
and their declared TXT keys — useful, and about a day's worth of the problem.

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
  Apple TV. These are a different firmware lineage and they advertise video
  through bit 49 rather than bit 0, so they are already answering a different
  question — whether they also accept the simpler session is unpublished, and a
  single evening with one would settle it.
- **pyatv #2899 merging**, which would make the play-queue shape a maintained
  reference rather than a draft.

Until one of those, the honest position is that AirPlay is a month of
reverse-engineering with a real chance of not working at the end, against DLNA's
afternoon.
