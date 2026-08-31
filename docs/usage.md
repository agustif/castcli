# Usage Guide

How to use `cast` to play media on your TV.

## Discovery vs direct addressing

### Scan first

```sh
cast scan
```

Shows all Cast, DLNA, and AirPlay devices on your network with their addresses and models. Use this to see what's available before playing.

### Play to a device

Three ways to specify which device:

1. **By name** (partial match):
   ```sh
   cast play movie.mkv --device "Living Room"
   ```

2. **By IP address** (skips discovery):
   ```sh
   cast play movie.mkv --ip 192.168.1.42
   ```

3. **No flags** (uses last device, or first found):
   ```sh
   cast play movie.mkv
   ```

The tool remembers the last device you used, so the second play doesn't need `--device`.

## Choosing tracks

### Let it choose

```sh
cast play movie.mkv
```

Audio and subtitles are chosen by language preference (`CAST_AUDIO_LANGUAGES` and `CAST_SUBTITLE_LANGUAGES`). For subtitles, when multiple tracks match the language, the one with the most cues wins — this avoids 24-cue forced-signage tracks that containers often flag as default.

### See what's available

```sh
cast streams movie.mkv
```

Shows all tracks with indices, languages, codecs, and cue counts. The `->` marks what `cast play` would choose.

Example output:

```
     [0] video    h264 eng
  -> [1] audio    aac eng 2ch
     [2] audio    ac3 spa 6ch
     [3] subtitle subrip spa 24 cues [default]
  -> [4] subtitle subrip spa 1670 cues
     [5] subtitle subrip eng 1988 cues
```

### Override

```sh
cast play movie.mkv --audio 2 --subs 5
```

Indices come from `cast streams`. An explicit `--subs` skips the cue-count survey and uses exactly what you asked for.

## Resume and seeking

### Resume automatically

```sh
cast play movie.mkv
```

Playback resumes where you stopped. The position is saved every 15 seconds to `$XDG_STATE_HOME/castcli/state.json`.

### Start from the beginning

```sh
cast play movie.mkv --seek 0
```

### Start at a specific time

```sh
cast play movie.mkv --seek 12:30      # 12 minutes 30 seconds
cast play movie.mkv --seek 1:23:45    # 1 hour 23 minutes 45 seconds
cast play movie.mkv --seek 90         # 90 seconds
```

## HLS vs Progressive

### HLS (default)

```sh
cast play movie.mkv
```

The TV fetches an HLS master playlist with multiple quality variants. The TV picks quality from its own buffer level and seeks by requesting different segments. Nothing restarts when quality changes or you seek.

**Falls back to progressive** if the file has no duration or is smaller than every quality rung.

### Progressive mode

```sh
cast play movie.mkv --progressive
```

Serves a single continuous stream at one quality. Seeking or changing quality restarts ffmpeg and reissues `LOAD` to the TV — a visible rebuffer.

Use this for files that can't be segmented or receivers that reject HLS.

## Control commands

Control commands attach to the running `cast play` session. They don't restart playback.

### Status

```sh
cast status
```

Shows the device state (`PLAYING`, `PAUSED`, `BUFFERING`) and position within the current stream.

### Pause and resume

```sh
cast pause
cast resume
cast toggle    # pause if playing, resume if paused
```

### Seek

```sh
# Absolute position
cast seek --to 15:00

# Relative
cast seek --forward 5:00
cast seek --back 30
```

**HLS mode:** the TV seeks natively.

**Progressive mode:** the running `cast play` restarts ffmpeg at the new offset.

### Volume

```sh
cast volume --level 50    # 0-100
```

### Stop

```sh
cast stop
```

Stops playback and closes the receiver session.

## AirPlay pairing

AirPlay devices require pairing before first use. You'll see a PIN on the TV screen (or use a known PIN for emulators/testing devices).

### Pair on first play

```sh
cast play movie.mkv --device "Apple TV" --pin 1234
```

Or set the environment variable:

```sh
export AIRPLAY_PIN=1234
cast play movie.mkv --device "Apple TV"
```

Pairing is stored by device ID in `$XDG_STATE_HOME/castcli/state.json`. Once paired, subsequent plays don't need the PIN.

### Pairing fail-closed

If pairing or verification fails, playback fails with an error. This prevents unauthenticated playback to devices that require pairing.

## Troubleshooting

### "Device not found"

**Check the device is on and awake.** Cast and DLNA devices go idle when not in use; wake them first (open an app on the TV, for example).

**Try direct IP:**

```sh
cast play movie.mkv --ip 192.168.1.42
```

mDNS unicast replies get dropped on congested networks. An explicit `--ip` skips discovery.

### "Could not reach device"

The device is off or on a different network. `cast scan` shows what's reachable.

### "The receiver rejected the stream"

The TV can't play this audio codec. Try a different `--audio` stream:

```sh
cast streams movie.mkv    # see what's available
cast play movie.mkv --audio 1
```

### "Media load failed" or fault code 716 (DLNA)

The TV can't fetch the URL. The advertised address isn't routable from the TV.

**Most common cause:** you're on a VPN and the tool advertised a VPN interface address (`tun0`, `utun3`) instead of your LAN address.

**Fix:** override the advertised address:

```sh
export CAST_ADVERTISE_HOST=192.168.1.100   # your machine's LAN address
cast play movie.mkv
```

Or disable the VPN while casting.

### Subtitles don't appear

**Check the track was chosen:**

```sh
cast streams movie.mkv
```

Look for `->` next to a subtitle track. If none is marked, no track matched your language preference or the file has no subtitles.

**Override:**

```sh
cast play movie.mkv --subs 5
```

### Playback stutters (progressive mode only)

The quality is too high for your network. The tool adapts automatically in progressive mode, but you can force a lower starting quality by editing the ladder in `packages/quality/src/Ladder.ts` or by using HLS mode (default), where the TV adapts itself.

### AirPlay: "PIN required"

You're playing to an AirPlay device for the first time. Provide the PIN shown on the TV:

```sh
cast play movie.mkv --device "Apple TV" --pin 1234
```

Or set `AIRPLAY_PIN=1234`.

### Position not saving

The position is written every 15 seconds to `$XDG_STATE_HOME/castcli/state.json`. If you stop playback within 15 seconds of starting, it won't be saved.

Check the file exists and is writable:

```sh
ls -la ~/.local/state/castcli/state.json
```

## Advanced usage

### Multiple devices

Each device is remembered separately. Play to one, then the other:

```sh
cast play movie.mkv --device "Living Room"
# ... later ...
cast play other.mkv --device "Bedroom"
cast pause --device "Living Room"   # control the first one
```

### Custom languages

```sh
export CAST_AUDIO_LANGUAGES=spa,eng,und
export CAST_SUBTITLE_LANGUAGES=spa
cast play movie.mkv
```

Audio tries Spanish first, then English, then undefined. Subtitles prefer Spanish.

### Control channel

`cast play` opens a unix domain socket at `/tmp/castcli-control-$USER.sock` (or `$XDG_RUNTIME_DIR/castcli-control.sock`). Control commands like `cast pause` connect to it.

If the socket is stale (from a crashed process), remove it:

```sh
rm /tmp/castcli-control-$USER.sock
```
