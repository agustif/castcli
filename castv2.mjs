// Google Cast v2 protocol client.
//
// The wire format is length-prefixed protobuf. CastMessage only has seven
// fields and we only ever send STRING payloads, so we hand-roll the encoding
// rather than pull in a protobuf runtime.
//
//   1 protocol_version  varint   (always 0 = CASTV2_1_0)
//   2 source_id         string
//   3 destination_id    string
//   4 namespace         string
//   5 payload_type      varint   (0 = STRING)
//   6 payload_utf8      string

import tls from 'node:tls'
import { EventEmitter } from 'node:events'

export const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
}

export const DEFAULT_MEDIA_RECEIVER = 'CC1AD845'

function encodeVarint(value) {
  const bytes = []
  let n = value
  do {
    let byte = n & 0x7f
    n >>>= 7
    if (n) byte |= 0x80
    bytes.push(byte)
  } while (n)
  return Buffer.from(bytes)
}

function readVarint(buf, off) {
  let result = 0
  let shift = 0
  while (off < buf.length) {
    const byte = buf[off++]
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return [result >>> 0, off]
}

function field(key, str) {
  const b = Buffer.from(str, 'utf8')
  return Buffer.concat([Buffer.from([key]), encodeVarint(b.length), b])
}

function encode({ sourceId, destinationId, namespace, payload }) {
  const body = Buffer.concat([
    Buffer.from([0x08, 0x00]), // protocol_version = 0
    field(0x12, sourceId),
    field(0x1a, destinationId),
    field(0x22, namespace),
    Buffer.from([0x28, 0x00]), // payload_type = STRING
    field(0x32, payload),
  ])
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(body.length)
  return Buffer.concat([prefix, body])
}

function decode(buf) {
  const msg = {}
  let off = 0
  while (off < buf.length) {
    const key = buf[off++]
    const fieldNo = key >> 3
    const wire = key & 7
    if (wire === 0) {
      const [, next] = readVarint(buf, off)
      off = next
    } else if (wire === 2) {
      const [len, next] = readVarint(buf, off)
      off = next
      const value = buf.subarray(off, off + len)
      off += len
      if (fieldNo === 2) msg.sourceId = value.toString('utf8')
      else if (fieldNo === 3) msg.destinationId = value.toString('utf8')
      else if (fieldNo === 4) msg.namespace = value.toString('utf8')
      else if (fieldNo === 6) msg.payload = value.toString('utf8')
    } else {
      break // we never send or receive other wire types
    }
  }
  return msg
}

export class CastClient extends EventEmitter {
  #socket = null
  #buffer = Buffer.alloc(0)
  #requestId = 1
  #heartbeat = null
  #connectedTo = new Set()

  constructor(host, port = 8009) {
    super()
    this.host = host
    this.port = port
    this.transportId = null
    this.sessionId = null
    this.mediaSessionId = null
  }

  connect() {
    return new Promise((resolve, reject) => {
      // Cast devices present a self-signed certificate chain.
      this.#socket = tls.connect(
        { host: this.host, port: this.port, rejectUnauthorized: false, servername: undefined },
        () => {
          this.#openVirtualConnection('receiver-0')
          this.#heartbeat = setInterval(() => {
            this.#send('receiver-0', NS.heartbeat, { type: 'PING' })
          }, 5000)
          resolve()
        },
      )
      this.#socket.setNoDelay(true)
      this.#socket.on('data', (chunk) => this.#onData(chunk))
      this.#socket.on('error', (err) => this.emit('error', err))
      this.#socket.on('close', () => {
        clearInterval(this.#heartbeat)
        this.emit('close')
      })
      this.#socket.once('error', reject)
    })
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    while (this.#buffer.length >= 4) {
      const len = this.#buffer.readUInt32BE(0)
      if (this.#buffer.length < 4 + len) break
      const frame = this.#buffer.subarray(4, 4 + len)
      this.#buffer = this.#buffer.subarray(4 + len)
      this.#handle(decode(frame))
    }
  }

  #handle(msg) {
    let payload
    try {
      payload = JSON.parse(msg.payload ?? '{}')
    } catch {
      return
    }
    if (payload.type === 'PING') {
      this.#send(msg.sourceId, NS.heartbeat, { type: 'PONG' })
      return
    }
    if (payload.type === 'RECEIVER_STATUS') {
      const app = payload.status?.applications?.find((a) => a.appId === DEFAULT_MEDIA_RECEIVER)
      if (app) {
        this.transportId = app.transportId
        this.sessionId = app.sessionId
      }
      this.emit('receiverStatus', payload.status ?? {})
    }
    if (payload.type === 'MEDIA_STATUS') {
      const status = payload.status?.[0]
      if (status?.mediaSessionId) this.mediaSessionId = status.mediaSessionId
      if (status) this.emit('mediaStatus', status)
    }
    if (payload.type === 'LOAD_FAILED' || payload.type === 'LOAD_CANCELLED') {
      this.emit('loadFailed', payload)
    }
    this.emit('message', msg.namespace, payload)
  }

  #send(destinationId, namespace, payload) {
    // During a reconnect there is no transport yet. Encoding a null
    // destination throws inside Buffer.from, which took the whole process
    // down mid-film.
    if (!destinationId) return
    if (!this.#socket || this.#socket.destroyed) return
    this.#socket.write(
      encode({
        sourceId: 'sender-0',
        destinationId,
        namespace,
        payload: JSON.stringify(payload),
      }),
    )
  }

  #openVirtualConnection(destinationId) {
    if (this.#connectedTo.has(destinationId)) return
    this.#connectedTo.add(destinationId)
    this.#send(destinationId, NS.connection, { type: 'CONNECT' })
  }

  nextRequestId() {
    return this.#requestId++
  }

  /** Launch the Default Media Receiver and wait for its transport to appear. */
  async launch(timeoutMs = 15000) {
    this.#send('receiver-0', NS.receiver, {
      type: 'LAUNCH',
      appId: DEFAULT_MEDIA_RECEIVER,
      requestId: this.nextRequestId(),
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('receiverStatus', onStatus)
        reject(new Error('timed out waiting for the receiver app to launch'))
      }, timeoutMs)
      const onStatus = () => {
        if (!this.transportId) return
        clearTimeout(timer)
        this.off('receiverStatus', onStatus)
        resolve()
      }
      this.on('receiverStatus', onStatus)
    })
    this.#openVirtualConnection(this.transportId)
  }

  /** Attach to whatever session is already running, without relaunching it. */
  async join(timeoutMs = 8000) {
    this.#send('receiver-0', NS.receiver, {
      type: 'GET_STATUS',
      requestId: this.nextRequestId(),
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('receiverStatus', onStatus)
        reject(new Error('no media receiver session is running on that device'))
      }, timeoutMs)
      const onStatus = () => {
        if (!this.transportId) return
        clearTimeout(timer)
        this.off('receiverStatus', onStatus)
        resolve()
      }
      this.on('receiverStatus', onStatus)
    })
    this.#openVirtualConnection(this.transportId)
    this.#send(this.transportId, NS.media, {
      type: 'GET_STATUS',
      requestId: this.nextRequestId(),
    })
  }

  load(media, { autoplay = true, currentTime = 0, activeTrackIds = [] } = {}) {
    this.#send(this.transportId, NS.media, {
      type: 'LOAD',
      requestId: this.nextRequestId(),
      sessionId: this.sessionId,
      media,
      autoplay,
      currentTime,
      ...(activeTrackIds.length ? { activeTrackIds } : {}),
    })
  }

  mediaCommand(type, extra = {}) {
    if (!this.mediaSessionId) return
    this.#send(this.transportId, NS.media, {
      type,
      requestId: this.nextRequestId(),
      mediaSessionId: this.mediaSessionId,
      ...extra,
    })
  }

  setVolume(level) {
    this.#send('receiver-0', NS.receiver, {
      type: 'SET_VOLUME',
      requestId: this.nextRequestId(),
      volume: { level: Math.max(0, Math.min(1, level)) },
    })
  }

  stopReceiver() {
    if (!this.sessionId) return
    this.#send('receiver-0', NS.receiver, {
      type: 'STOP',
      requestId: this.nextRequestId(),
      sessionId: this.sessionId,
    })
  }

  close() {
    clearInterval(this.#heartbeat)
    this.#socket?.destroy()
  }
}
