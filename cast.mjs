#!/usr/bin/env node
// cast — stream a local video file to a Google Cast device.
//
// Why this exists: VLC 3 builds the pull-URL it hands the TV from whichever
// local address its socket happens to be bound to. When the device resolves
// over IPv6 it advertises a link-local address with a zone index
// (http://fe80::...%en0:8010/...), which is unroutable from the TV, and every
// load fails. We pin an explicit LAN IPv4 instead.
//
// The TV pulls from an HTTP server we run here. ffmpeg remuxes on the fly into
// fragmented MP4: video is stream-copied when it is already H.264, and only the
// audio is re-encoded (Cast receivers do not decode AC-3/E-AC-3 reliably, and
// never accept Matroska).

import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { discover } from './mdns.mjs'
import { CastClient } from './castv2.mjs'
import { buildLadder, describeRung, QualityController } from './adaptive.mjs'
import { extractCues, serializeVtt } from './vtt.mjs'

/** Accept ffmpeg-style rate strings: 1800k, 3M, or plain bits per second. */
function parseBitrate(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/)
  if (!match) return 3_000_000
  const n = Number(match[1])
  const unit = match[2]?.toLowerCase()
  return Math.round(unit === 'm' ? n * 1e6 : unit === 'k' ? n * 1e3 : n)
}

const execFileAsync = promisify(execFile)

const CAST_SERVICE = '_googlecast._tcp.local'
const CAST_MAX_H264_HEIGHT = 1080

// ---------------------------------------------------------------- utilities

function parseArgs(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      opts._.push(arg)
      continue
    }
    const key = arg.slice(2)
    const needsValue = [
      'device', 'seek', 'audio', 'subs', 'port', 'host', 'timeout', 'abitrate',
      'ip', 'cast-port', 'scale', 'vbitrate',
    ]
    if (needsValue.includes(key)) opts[key] = argv[++i]
    else opts[key] = true
  }
  return opts
}

function parseTime(value) {
  if (value == null) return 0
  const parts = String(value).split(':').map(Number)
  if (parts.some(Number.isNaN)) return 0
  return parts.reduce((acc, part) => acc * 60 + part, 0)
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const s = Math.floor(seconds % 60)
  const m = Math.floor((seconds / 60) % 60)
  const h = Math.floor(seconds / 3600)
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * Pick the LAN IPv4 to advertise. Explicitly never IPv6 — a link-local v6
 * address with a zone index is exactly the bug we are working around.
 */
function pickLanAddress(preferred) {
  if (preferred) return preferred
  const ifaces = os.networkInterfaces()
  const order = ['en0', 'en1', ...Object.keys(ifaces)]
  for (const name of order) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  throw new Error('no non-loopback IPv4 address found — are you on Wi-Fi?')
}

async function probe(file) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    file,
  ], { maxBuffer: 32 * 1024 * 1024 })
  const info = JSON.parse(stdout)
  return {
    duration: Number(info.format?.duration) || 0,
    streams: info.streams ?? [],
  }
}

function describeStreams(streams) {
  return streams.map((s) => {
    const lang = s.tags?.language ?? '??'
    const title = s.tags?.title ? ` "${s.tags.title}"` : ''
    if (s.codec_type === 'video') {
      return `  [${s.index}] video    ${s.codec_name} ${s.profile ?? ''} ${s.width}x${s.height}${title}`
    }
    if (s.codec_type === 'audio') {
      return `  [${s.index}] audio    ${s.codec_name} ${s.channels}ch ${lang}${title}`
    }
    if (s.codec_type === 'subtitle') {
      return `  [${s.index}] subtitle ${s.codec_name} ${lang}${title}`
    }
    return `  [${s.index}] ${s.codec_type}`
  }).join('\n')
}

// ------------------------------------------------------------------ ffmpeg

/**
 * Decide whether the video can be stream-copied. Cast receivers handle H.264
 * up to 1080p; anything else (HEVC, AV1, 10-bit, oversized) has to be encoded,
 * for which we use VideoToolbox so it stays realtime on Apple silicon.
 */
function planVideo(videoStream, force) {
  if (force) return { copy: false, reason: 'forced' }
  if (!videoStream) return { copy: false, reason: 'no video stream' }
  const pixFmt = videoStream.pix_fmt ?? ''
  if (videoStream.codec_name !== 'h264') {
    return { copy: false, reason: `${videoStream.codec_name} is not H.264` }
  }
  if (!pixFmt.startsWith('yuv420p') || pixFmt.includes('10')) {
    return { copy: false, reason: `pixel format ${pixFmt} is not 8-bit 4:2:0` }
  }
  if (Number(videoStream.height) > CAST_MAX_H264_HEIGHT) {
    return { copy: false, reason: `${videoStream.height}p exceeds 1080p` }
  }
  return { copy: true, reason: 'H.264 8-bit 4:2:0, stream-copied' }
}

function buildFfmpegArgs({ file, offset, videoIndex, audioIndex, rung, audioBitrate }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  if (offset > 0) args.push('-ss', String(offset))
  args.push('-i', file)
  args.push('-map', `0:${videoIndex}`)
  if (audioIndex != null) args.push('-map', `0:${audioIndex}`)

  if (rung.copy) {
    args.push('-c:v', 'copy')
  } else {
    // VideoToolbox keeps this comfortably realtime on Apple silicon, so the
    // limiting factor stays the network rather than the CPU.
    const bitrate = String(rung.bitrate)
    args.push(
      '-c:v', 'h264_videotoolbox',
      '-profile:v', 'high',
      '-b:v', bitrate,
      '-maxrate', bitrate,
      '-bufsize', String(rung.bitrate * 2),
      '-g', '48',
      '-vf', `scale=-2:'min(${rung.height},ih)'`,
    )
  }

  // AAC-LC stereo is the one audio format every Cast receiver accepts.
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', audioBitrate)

  args.push(
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  )
  return args
}

// ------------------------------------------------------------------ server

function createMediaServer({ file, videoIndex, audioIndex, audioBitrate, state, subtitleIndex, getRung, onBytes }) {
  const children = new Set()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (state.verbose) {
      process.stdout.write(`\n  <- ${req.method} ${req.url} from ${req.socket.remoteAddress}\n`)
    }

    if (url.pathname === '/subs.vtt') {
      // Served complete and in one shot, with a Content-Length: a slow chunked
      // reply makes the receiver render cues progressively, stacking them up
      // instead of replacing them. The video restarts with timestamps rebased
      // to zero, so cut the cues from the same offset or they drift by it.
      const subOffset = Number(url.searchParams.get('o')) || 0
      const body = Buffer.from(serializeVtt(state.cues ?? [], subOffset), 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Content-Length': body.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }

    if (url.pathname !== '/stream') {
      res.writeHead(404).end('not found')
      return
    }

    // The stream is a live pipe, so byte ranges are meaningless: always answer
    // 200 and let the receiver read to EOF. Seeking is handled by restarting
    // ffmpeg at a new offset and re-issuing LOAD.
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'none',
      'Connection': 'close',
      'Cache-Control': 'no-store',
    })
    if (req.method === 'HEAD') return res.end()

    const offset = Number(url.searchParams.get('o')) || 0
    const args = buildFfmpegArgs({
      file, offset, videoIndex, audioIndex, rung: getRung(), audioBitrate,
    })
    const child = spawn('ffmpeg', args)
    children.add(child)

    // Count bytes the receiver actually accepts, honouring backpressure: in
    // steady state this rate is the link's real throughput, which is what the
    // quality controller reasons about.
    child.stdout.on('data', (chunk) => {
      onBytes?.(chunk.length)
      if (!res.write(chunk)) {
        child.stdout.pause()
        res.once('drain', () => child.stdout.resume())
      }
    })
    child.stdout.on('end', () => res.end())
    child.stderr.on('data', (d) => {
      const text = d.toString().trim()
      if (text) state.lastFfmpegError = text
    })
    child.on('error', (err) => {
      state.lastFfmpegError = err.message
      res.end()
    })
    const cleanup = () => {
      children.delete(child)
      child.kill('SIGKILL')
    }
    child.on('close', () => children.delete(child))
    res.on('close', cleanup)
  })

  server.killTranscodes = () => {
    for (const child of children) child.kill('SIGKILL')
    children.clear()
  }
  return server
}

// ------------------------------------------------------------------ actions

/** Discovery is unreliable on a single pass, so sweep a few times. */
async function findDevices(timeoutMs) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const devices = await discover(CAST_SERVICE, timeoutMs)
    if (devices.some((d) => d.ip)) return devices.filter((d) => d.ip)
  }
  return []
}

async function cmdScan(opts) {
  process.stdout.write('scanning for Cast devices…\n')
  const devices = await findDevices(Number(opts.timeout) || 4000)
  if (!devices.length) {
    console.log('none found. Check that the TV is awake and on the same Wi-Fi network.')
    return
  }
  for (const d of devices) {
    console.log(`\n  ${d.name}`)
    console.log(`    address   ${d.ip ?? d.host}:${d.port}`)
    console.log(`    model     ${d.txt?.md ?? 'unknown'}`)
    console.log(`    status    ${d.txt?.rs || 'idle'}`)
    console.log(`    id        ${d.txt?.id ?? '-'}`)
  }
  console.log(`\nlocal address to advertise: ${pickLanAddress(opts.host)}`)
}

async function cmdCast(file, opts) {
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`)

  const { duration, streams } = await probe(file)
  const videoStream = streams.find((s) => s.codec_type === 'video')
  const audioStreams = streams.filter((s) => s.codec_type === 'audio')
  const subtitleStreams = streams.filter((s) => s.codec_type === 'subtitle')

  if (!videoStream) throw new Error('no video stream in this file')

  if (opts.streams) {
    console.log(describeStreams(streams))
    return
  }

  const audioIndex = opts.audio != null
    ? Number(opts.audio)
    : audioStreams[0]?.index ?? null
  const subtitleIndex = opts.subs != null ? Number(opts.subs) : null
  const subtitleLanguage =
    subtitleStreams.find((s) => s.index === subtitleIndex)?.tags?.language ?? 'und'
  const audioBitrate = opts.abitrate ?? '128k'

  // Quality is adaptive unless the user pins it with --scale/--vbitrate.
  const pinned = opts.scale != null || opts.vbitrate != null
  const canCopy = planVideo(videoStream, opts['transcode-video']).copy
  const sourceBitrate = Number(videoStream.bit_rate) || null
  const ladder = pinned
    ? [{
        height: Number(opts.scale) || Number(videoStream.height),
        bitrate: parseBitrate(opts.vbitrate ?? '3M'),
        copy: false,
      }]
    : buildLadder({
        sourceHeight: Number(videoStream.height),
        sourceBitrate,
        canCopy,
      })
  if (!ladder.length) throw new Error('could not build a quality ladder for this file')

  // Start one rung below the top: the warm-up measurement corrects this within
  // ~15s, and starting low means the picture appears immediately.
  let rungIndex = pinned ? 0 : Math.max(0, Math.min(ladder.length - 1, 2))

  // mDNS unicast replies get dropped often enough that --ip is worth having:
  // it skips discovery entirely.
  let device
  if (opts.ip) {
    device = { name: opts.ip, ip: opts.ip, port: Number(opts['cast-port']) || 8009 }
  } else {
    process.stdout.write('scanning for Cast devices…\n')
    const devices = await findDevices(Number(opts.timeout) || 4000)
    if (!devices.length) {
      throw new Error('no Cast devices found. Pass --ip <address> to skip discovery.')
    }
    device = opts.device
      ? devices.find((d) => d.name.toLowerCase().includes(String(opts.device).toLowerCase()))
      : devices[0]
    if (!device) {
      throw new Error(
        `no device matching "${opts.device}". Found: ${devices.map((d) => d.name).join(', ')}`,
      )
    }
    if (!device.ip) throw new Error(`could not resolve an IPv4 address for ${device.name}`)
  }

  const localAddress = pickLanAddress(opts.host)
  const port = Number(opts.port) || 8021
  const state = {
    offset: parseTime(opts.seek),
    paused: false,
    position: 0,
    lastFfmpegError: null,
    verbose: Boolean(opts.verbose),
    cues: [],
  }

  // Extracted once up front rather than per request: one pass over the
  // container, then every seek is an in-memory re-cut.
  if (subtitleIndex != null) {
    process.stdout.write('extracting subtitles…\n')
    state.cues = await extractCues(file, subtitleIndex)
  }

  let controller = null
  const server = createMediaServer({
    file,
    videoIndex: videoStream.index,
    audioIndex,
    audioBitrate,
    state,
    subtitleIndex,
    getRung: () => ladder[rungIndex],
    onBytes: (n) => controller?.noteBytes(n),
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', resolve)
  })

  const baseUrl = `http://${localAddress}:${port}`
  console.log(`\n  file     ${path.basename(file)}`)
  console.log(`  video    ${videoStream.codec_name} ${videoStream.width}x${videoStream.height}`)
  console.log(`  quality  ${pinned ? 'pinned' : 'adaptive'} — starting at ${describeRung(ladder[rungIndex])}`)
  if (!pinned) console.log(`  ladder   ${ladder.map(describeRung).join('  |  ')}`)
  console.log(`  audio    stream ${audioIndex} → aac 2ch ${audioBitrate}`)
  if (subtitleIndex != null) console.log(`  subs     stream ${subtitleIndex} → webvtt`)
  console.log(`  serving  ${baseUrl}/stream`)
  console.log(`  device   ${device.name} (${device.ip}:${device.port})\n`)

  // The control socket is the fragile part of this whole system: on a weak
  // link the TV resets it (ECONNRESET) with no warning. Losing it must not end
  // the film, so the client is rebuildable and playback resumes where it was.
  let client = new CastClient(device.ip, device.port)
  const wireClient = () => {
    client.on('error', (err) => console.error(`\ncast error: ${err.message}`))
    client.on('mediaStatus', onMediaStatus)
    client.on('loadFailed', onLoadFailed)
    client.on('close', onClose)
  }

  await client.connect()
  await client.launch()

  let tracksActivated = false
  let reconnecting = false

  const sendLoad = () => {
    // A rung change can land while the socket is being rebuilt; the reconnect
    // path issues its own LOAD once the new transport exists.
    if (reconnecting || !client.transportId) return
    // Each LOAD installs a fresh text track. Without explicitly clearing the
    // previous one first, the receiver leaves its already-rendered cues painted
    // on screen and draws the new track's cues above them — so the subtitles
    // from before a quality switch stay stuck at the bottom forever.
    if (subtitleIndex != null) {
      client.mediaCommand('EDIT_TRACKS_INFO', { activeTrackIds: [] })
      tracksActivated = false
    }
    const media = {
      contentId: `${baseUrl}/stream?o=${state.offset}&r=${client.nextRequestId()}`,
      contentType: 'video/mp4',
      streamType: 'BUFFERED',
      duration: duration ? Math.max(0, duration - state.offset) : undefined,
      // No metadata.title: the Default Media Receiver pins it as a permanent
      // on-screen overlay for a live-style stream, sitting over the subtitles.
      ...(subtitleIndex != null
        ? {
            // Cast receivers silently ignore a TEXT track with no `language`.
            tracks: [{
              trackId: 1,
              type: 'TEXT',
              subtype: 'SUBTITLES',
              trackContentId: `${baseUrl}/subs.vtt?o=${state.offset}`,
              trackContentType: 'text/vtt',
              language: subtitleLanguage,
              name: `Subtitles (${subtitleLanguage})`,
            }],
          }
        : {}),
    }
    client.load(media, { activeTrackIds: subtitleIndex != null ? [1] : [] })
  }

  function onMediaStatus(status) {
    state.position = state.offset + (status.currentTime ?? 0)
    state.paused = status.playerState === 'PAUSED'
    controller?.noteState(status.playerState)
    // activeTrackIds in LOAD is frequently ignored; EDIT_TRACKS_INFO is what
    // actually turns the text track on, and it needs a mediaSessionId first.
    if (subtitleIndex != null && !tracksActivated && client.mediaSessionId) {
      tracksActivated = true
      client.mediaCommand('EDIT_TRACKS_INFO', { activeTrackIds: [1] })
    }
  }
  function onLoadFailed() {
    console.error('\nthe receiver rejected the stream.')
    if (state.lastFfmpegError) console.error(`ffmpeg said: ${state.lastFfmpegError}`)
    console.error('try --transcode-video, or a different --audio stream.')
  }

  // Rebuild the session rather than exiting. Resuming from the last known
  // position is what makes the drop invisible to whoever is watching.
  async function onClose() {
    if (shuttingDown || reconnecting) return
    reconnecting = true
    const resumeAt = Math.max(0, Math.floor(state.position))
    process.stdout.write(`\n  connection lost — reconnecting at ${formatTime(resumeAt)}…\n`)
    for (let attempt = 1; attempt <= 30 && !shuttingDown; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)))
      try {
        client.removeAllListeners()
        client = new CastClient(device.ip, device.port)
        wireClient()
        await client.connect()
        await client.launch()
        state.offset = resumeAt
        server.killTranscodes()
        controller?.noteRestart()
        sendLoad()
        process.stdout.write(`  reconnected\n`)
        reconnecting = false
        return
      } catch (err) {
        process.stdout.write(`  reconnect attempt ${attempt} failed: ${err.message}\n`)
      }
    }
    reconnecting = false
  }

  wireClient()

  sendLoad()

  const seekTo = (seconds) => {
    state.offset = Math.max(0, Math.min(duration || Infinity, seconds))
    server.killTranscodes()
    controller?.noteRestart()
    sendLoad()
  }

  if (!pinned) {
    controller = new QualityController({
      ladder,
      index: rungIndex,
      log: (line) => process.stdout.write(`\n  ${line}\n`),
      onSwitch: () => {
        rungIndex = controller.index
        // A rung change means re-encoding, which means restarting ffmpeg and
        // reloading. Resume from where the viewer actually is.
        seekTo(state.position)
      },
    })
    controller.start()
  }

  // -------------------------------------------------------------- controls
  let volume = 1
  readline.emitKeypressEvents(process.stdin)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('keypress', (_str, key) => {
    if (!key) return
    if (key.name === 'space') {
      state.paused ? client.mediaCommand('PLAY') : client.mediaCommand('PAUSE')
      state.paused = !state.paused
    } else if (key.name === 'right') {
      seekTo(state.position + (key.shift ? 60 : 10))
    } else if (key.name === 'left') {
      seekTo(state.position - (key.shift ? 60 : 10))
    } else if (key.name === 'up') {
      volume = Math.min(1, volume + 0.05)
      client.setVolume(volume)
    } else if (key.name === 'down') {
      volume = Math.max(0, volume - 0.05)
      client.setVolume(volume)
    } else if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      shutdown()
    } else if (key.name === 's') {
      client.stopReceiver()
      shutdown()
    }
  })

  // Receivers only push MEDIA_STATUS on state changes, but polling for it
  // re-triggers the on-screen media overlay — at 1Hz that pins the overlay
  // permanently over the video. So advance the clock locally and resync only
  // occasionally.
  let lastTick = Date.now()
  let sincePoll = 0
  const ticker = setInterval(() => {
    const now = Date.now()
    const elapsed = (now - lastTick) / 1000
    lastTick = now
    if (!state.paused) state.position += elapsed

    sincePoll += elapsed
    if (sincePoll >= 15) {
      sincePoll = 0
      client.mediaCommand('GET_STATUS')
    }

    const total = duration ? ` / ${formatTime(duration)}` : ''
    const label = state.paused ? 'paused ' : 'playing'
    process.stdout.write(`\r  ${label}  ${formatTime(state.position)}${total}   vol ${Math.round(volume * 100)}%   `)
  }, 1000)

  let shuttingDown = false
  function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(ticker)
    controller?.stop()
    server.killTranscodes()
    server.close()
    client.close()
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdout.write('\n')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)

  console.log('  space play/pause   ←/→ seek 10s (shift: 60s)   ↑/↓ volume   s stop   q quit\n')
}

// -------------------------------------------------------------------- main

const USAGE = `
cast — stream a local file to a Google Cast device

  cast scan                       list devices on the network
  cast <file> [options]           stream a file
  cast <file> --streams           list the file's tracks and exit

options
  --device <substring>   pick a device by name (default: first found)
  --seek <s | mm:ss>     start at this position
  --audio <index>        audio stream index (see --streams)
  --subs <index>         serve a subtitle track as a WebVTT sidecar
  --scale <height>       pin the height and disable adaptive quality
  --vbitrate <rate>      pin the video bitrate and disable adaptive quality
  --transcode-video      re-encode video instead of stream-copying
  --abitrate <rate>      audio bitrate (default 128k)
  --verbose              log every request the receiver makes
  --port <n>             local HTTP port (default 8021)
  --host <ip>            LAN address to advertise (default: auto-detected IPv4)
  --timeout <ms>         discovery timeout (default 3000)

controls
  space play/pause   ←/→ seek 10s (shift: 60s)   ↑/↓ volume   s stop   q quit
`

const opts = parseArgs(process.argv.slice(2))
const target = opts._[0]

try {
  if (!target || opts.help) {
    console.log(USAGE)
  } else if (target === 'scan') {
    await cmdScan(opts)
  } else {
    await cmdCast(path.resolve(target), opts)
  }
} catch (err) {
  console.error(`\nerror: ${err.message}\n`)
  process.exit(1)
}
