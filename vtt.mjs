// WebVTT handling.
//
// Subtitles are extracted from the container exactly once and kept in memory as
// structured cues. Serving them any other way turned out to be the bug behind
// subtitles "accumulating" on screen: piping ffmpeg straight to the response
// produced a chunked reply with no Content-Length that took ~6s to finish, and
// the receiver renders such a track progressively as it arrives instead of
// treating it as one complete file.
//
// Holding the cues also makes seeking free: re-cutting for a new offset is a
// filter and a subtraction rather than another pass over a multi-gigabyte file.

import { spawn } from 'node:child_process'

/** Parse `HH:MM:SS.mmm` or `MM:SS.mmm` into seconds. */
function parseTimestamp(value) {
  const parts = value.trim().split(':')
  const seconds = Number(parts.pop())
  const minutes = Number(parts.pop() ?? 0)
  const hours = Number(parts.pop() ?? 0)
  return hours * 3600 + minutes * 60 + seconds
}

function formatTimestamp(seconds) {
  const clamped = Math.max(0, seconds)
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped / 60) % 60)
  const s = Math.floor(clamped % 60)
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`
}

const CUE_LINE = /^([\d:.]+)\s*-->\s*([\d:.]+)(.*)$/

export function parseVtt(text) {
  const cues = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const match = CUE_LINE.exec(lines[i] ?? '')
    if (!match) continue
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? ''
      if (line.trim() === '' || CUE_LINE.test(line)) break
      body.push(line)
      i = j
    }
    cues.push({
      start: parseTimestamp(match[1]),
      end: parseTimestamp(match[2]),
      settings: (match[3] ?? '').trim(),
      text: body.join('\n'),
    })
  }
  return cues
}

/** Serialise cues still visible at or after `offset`, rebased to zero. */
export function serializeVtt(cues, offset = 0) {
  const out = ['WEBVTT', '']
  for (const cue of cues) {
    if (cue.end <= offset) continue
    const start = cue.start - offset
    const end = cue.end - offset
    const settings = cue.settings ? ` ${cue.settings}` : ''
    out.push(`${formatTimestamp(start)} --> ${formatTimestamp(end)}${settings}`)
    out.push(cue.text)
    out.push('')
  }
  return out.join('\n')
}

/** Extract one subtitle stream from a container into cues. Runs ffmpeg once. */
export function extractCues(file, streamIndex) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', file,
      '-map', `0:${streamIndex}`,
      '-f', 'webvtt', 'pipe:1',
    ])
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg failed extracting subtitles (${code}): ${stderr.trim()}`))
        return
      }
      resolve(parseVtt(stdout))
    })
  })
}
