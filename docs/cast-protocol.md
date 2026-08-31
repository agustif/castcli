# Cast Protocol Reference

Wire protocol details verified against real Cast devices. Most of these are not documented by Google and fail silently.

## Transport

TLS on port 8009, self-signed certificate, so verification must be off. Frames
are a 4-byte big-endian length prefix followed by a protobuf `CastMessage`:

| # | Field | Type |
|---|---|---|
| 1 | `protocol_version` | varint, always 0 |
| 2 | `source_id` | string |
| 3 | `destination_id` | string |
| 4 | `namespace` | string |
| 5 | `payload_type` | varint, 0 = STRING |
| 6 | `payload_utf8` | string |

Only seven fields and we only ever send STRING payloads, so hand-encoding is
smaller than a protobuf runtime. Frames do **not** align with TCP reads: the
partial tail of every read has to be carried forward.

## Virtual connections

One socket multiplexes several logical connections, each addressed by a
destination id. **You must send `CONNECT` to a destination before it will accept
anything**, and there is no error if you forget — messages are simply ignored.

Well-known destinations: `receiver-0` always exists. The media transport id is
assigned per session and arrives in `RECEIVER_STATUS` after you `LAUNCH`.

## Heartbeat

`PING` every 5 seconds on the heartbeat namespace, and answer the device's own
`PING` with `PONG`. Stop and the receiver drops you.

## Launching

`LAUNCH` with `appId: "CC1AD845"` (Default Media Receiver). Wait for a
`RECEIVER_STATUS` whose `applications[]` contains that appId, then take both
`transportId` and `sessionId` from it, and `CONNECT` to the transport before
sending any media command.

## The pull model

The device fetches media from you. Nothing is pushed. Consequences:

- The URL you advertise must be reachable **from the device**, which is where
  VLC fails: it advertises whatever local address its socket is bound to, and on
  an IPv6-resolved device that is a link-local `fe80::…%en0` address that cannot
  be routed back. Always advertise an explicit LAN IPv4.
- Your HTTP server must be reachable on the LAN, so on macOS the Local Network
  permission matters (`Privacy & Security → Local Network`).

## Media constraints

| | Accepted | Rejected |
|---|---|---|
| Container | MP4 (fragmented), WebM | **Matroska** |
| Video | H.264 ≤1080p, 8-bit 4:2:0, VP8 | HEVC, AV1, 10-bit |
| Audio | AAC-LC, MP3, Opus, Vorbis | **AC-3, E-AC-3, DTS** |

Fragmented MP4 (`-movflags frag_keyframe+empty_moov+default_base_moof`) is what
lets playback start before the file is complete. A plain MP4 makes the receiver
wait for a `moov` atom that a live pipe never produces.

## Subtitles: four separate silent failures

Each of these produces *no error* and *no subtitles*.

1. **A `TEXT` track with no `language` is ignored.** Set it, even to `und`.
2. **`activeTrackIds` in `LOAD` is not reliably honoured.** Send
   `EDIT_TRACKS_INFO` with the track ids after the first `MEDIA_STATUS`; that is
   what actually turns the track on.
3. **Old cues survive a reload.** Before re-issuing `LOAD`, clear the current
   track with `EDIT_TRACKS_INFO { activeTrackIds: [] }`, or the receiver keeps
   its already-rendered cues painted on screen and draws the new track's cues
   above them. Subtitles from before a quality switch otherwise stay stuck at
   the bottom of the screen permanently.
4. **A slow text track is parsed progressively.** Serve the whole VTT in one
   response with a `Content-Length`. Streaming it as chunked output from ffmpeg
   — which takes seconds, because extracting subtitles means demuxing the entire
   container — makes cues accumulate instead of replacing each other.

Also note the source track flagged `default` is frequently a *forced* signage
track (location cards, on-screen text) with a couple of dozen cues, not
dialogue. Check the cue count before assuming.

## On-screen overlay quirks

- **`metadata.title` is pinned permanently.** On a live-style stream the
  receiver renders the title as a persistent overlay across the video, sitting
  on top of the subtitles. Omit metadata entirely.
- **Polling `GET_STATUS` re-triggers the media UI.** At 1 Hz this pins the
  transport overlay on screen indefinitely. Receivers only push `MEDIA_STATUS`
  on state changes, so interpolate the clock locally and resync occasionally
  (every 15s here) rather than polling.

## Seeking

There is no usable seek for a live pipe: byte ranges are meaningless, and the
receiver's own `SEEK` command does not help. Sent one, it re-requests the same
URL and restarts the stream from its beginning — while reporting the position
that was asked for, so the command looks like it worked.

Progressive seeking is therefore implemented by restarting ffmpeg at a new input
offset and re-issuing `LOAD`. Input seeking (`-ss` before `-i`) rebases output
timestamps to zero, which is what lets the receiver treat each restart as a
fresh stream — and is also why the subtitle track has to be re-cut from the same
offset, or it drifts by exactly the seek amount.

Under HLS none of that applies. A VOD playlist makes every segment addressable,
so `SEEK` means what it says and the subtitle track covers the whole film.

## Reconnection

The control socket drops. On a weak link the device resets it (`ECONNRESET`)
with no warning. Treat that as recoverable: rebuild the client, relaunch, and
reload at the last known position. Exiting on socket close ends the film.

## Discovery

mDNS (`_googlecast._tcp.local`). Setting the QU (unicast-response) bit in the
question's class field lets you listen on an ephemeral port instead of fighting
mDNSResponder for 5353; Cast devices honour it. Replies still get dropped on a
congested network often enough that a single sweep is unreliable — repeat the
query and retry the whole sweep. The TXT record carries `fn` (friendly name),
`md` (model) and `rs` (current status).

## Sources

Nothing above is guesswork about the wire format itself. Two authoritative
artefacts, plus one that is more authoritative than the prose:

| What | Source |
|---|---|
| `CastMessage` fields and wire numbers | `docs/reference/cast_channel.proto`, vendored from Chromium (BSD). Descriptors are **generated** from it — `npm run codegen`, checked by `npm run codegen:check`. |
| Media message shapes (`LoadRequest`, `MediaInfo`, `Track`) | The published Cast SDK reference for `chrome.cast.media.*` |
| Enum values | Read out of Google's shipped `cast_receiver_framework.js`, because the docs render several of them as bare types with no values |

The transport handshake (`CONNECT`, heartbeat, the receiver namespace) is the
one part Google does not document; that is established by observation and by
prior community work.

The disagreements below are no longer transcribed by hand: the shipped
framework's enum tables are extracted into
`packages/protocol/vendor/cast_receiver_vocabulary.json` and generated into
`GeneratedVocabulary.ts`, so an upstream change appears as a diff rather than as
a device that ignores a message. Doing this corrected `HlsSegmentFormat`, which
has eight values rather than the four recorded here.

### Where the prose and the shipped code disagree

Two cases where trusting the documentation would produce a subtly wrong payload:

- **`HlsSegmentFormat` is lowercase on the wire** — `ts_aac`, `ts_he_aac`,
  `e_ac3`, `fmp4` — although the sender-side reference writes them capitalised.
- **The third `StreamType` differs by side**: the sender SDK documents `OTHER`,
  the receiver framework ships `NONE`. Both are accepted in `Media.ts`; we only
  ever send `BUFFERED`.

`MetadataType` is also the one enum that is numeric rather than a string
(`GENERIC:0` … `AUDIOBOOK_CHAPTER:5`).

### What the reference confirms

The subtitle failure that took longest to diagnose is documented, once you know
where to look. From `chrome.cast.media.Track`:

> **language** — Language tag as per RFC 5646. *Mandatory when the subtype is
> SUBTITLES.*

`Media.Track` therefore makes `language` required rather than optional, so
omitting it is a compile error instead of a receiver that silently shows no
subtitles.
