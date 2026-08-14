#!/usr/bin/env node
// ctl — inspect or nudge a Cast session that is already running.
//
// Attaches to the live receiver session rather than launching a new one, so it
// can be used while `cast` is streaming without interrupting playback.
//
//   ctl <ip>                    print status
//   ctl <ip> --toggle           pause if playing, resume if paused
//   ctl <ip> --pause / --play
//   ctl <ip> --volume 20        set volume to 20%
//   ctl <ip> --stop

import { CastClient } from './castv2.mjs'

const argv = process.argv.slice(2)
const ip = argv.find((a) => !a.startsWith('--'))
if (!ip) {
  console.error('usage: ctl <ip> [--toggle] [--pause] [--play] [--volume <0-100>] [--stop]')
  process.exit(1)
}
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? null : (argv[i + 1] ?? true)
}

const client = new CastClient(ip)
client.on('error', (err) => {
  console.error(`error: ${err.message}`)
  process.exit(1)
})

const formatTime = (s) => {
  s = Math.max(0, Math.floor(s || 0))
  const pad = (n) => String(n).padStart(2, '0')
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s / 60) % 60))}:${pad(s % 60)}`
}

let receiverStatus = null
client.on('receiverStatus', (s) => { receiverStatus = s })

await client.connect()
await client.join()

const mediaStatus = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 5000)
  client.once('mediaStatus', (s) => {
    clearTimeout(timer)
    resolve(s)
  })
})

const volume = flag('volume')
let acted = false

if (volume !== null && volume !== true) {
  client.setVolume(Number(volume) / 100)
  acted = true
}
// `--toggle` is the one you want bound to a key: it flips whatever the
// receiver is currently doing, so you don't have to know the state first.
// Anything that isn't PAUSED counts as playing: the receiver spends a lot of
// time in BUFFERING, and a toggle that silently does nothing in that state is
// worse than one that treats it as "currently playing".
const wantsToggle = flag('toggle') !== null
const isPaused = mediaStatus?.playerState === 'PAUSED'
if (flag('pause') !== null || (wantsToggle && !isPaused)) {
  client.mediaCommand('PAUSE')
  acted = true
}
if (flag('play') !== null || (wantsToggle && isPaused)) {
  client.mediaCommand('PLAY')
  acted = true
}
if (flag('stop') !== null) {
  client.stopReceiver()
  console.log('stopped')
  setTimeout(() => process.exit(0), 500)
}

// Re-read after acting: reporting the status we fetched *before* sending the
// command would show the old state and read as if nothing happened.
const finalStatus = acted
  ? await new Promise((resolve) => {
      setTimeout(() => {
        client.mediaCommand('GET_STATUS')
        const timer = setTimeout(() => resolve(mediaStatus), 2500)
        client.once('mediaStatus', (s) => {
          clearTimeout(timer)
          resolve(s)
        })
      }, 400)
    })
  : mediaStatus

console.log(`state     ${finalStatus?.playerState ?? 'unknown'}`)
console.log(`position  ${formatTime(finalStatus?.currentTime)} (relative to the current stream)`)
console.log(`volume    ${Math.round((receiverStatus?.volume?.level ?? 0) * 100)}%`)

client.close()
process.exit(0)
