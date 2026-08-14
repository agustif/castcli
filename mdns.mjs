// Minimal mDNS service browser. No dependencies, no external binaries.
//
// We ask for a unicast response (the QU bit in the question's class field) so we
// can listen on an ephemeral port instead of fighting mDNSResponder for 5353.
// Cast devices honour QU.

import dgram from 'node:dgram'
import { once } from 'node:events'

const MDNS_ADDR = '224.0.0.251'
const MDNS_PORT = 5353

const TYPE_A = 1
const TYPE_PTR = 12
const TYPE_TXT = 16
const TYPE_SRV = 33

function encodeName(name) {
  const bufs = []
  for (const label of name.replace(/\.$/, '').split('.')) {
    const b = Buffer.from(label, 'utf8')
    bufs.push(Buffer.from([b.length]), b)
  }
  bufs.push(Buffer.from([0]))
  return Buffer.concat(bufs)
}

function buildQuery(name, type) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0, 0) // id
  header.writeUInt16BE(0, 2) // flags: standard query
  header.writeUInt16BE(1, 4) // qdcount
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(type, 0)
  tail.writeUInt16BE(0x8001, 2) // QU bit set, class IN
  return Buffer.concat([header, encodeName(name), tail])
}

// Returns [name, offsetPastName]. Follows compression pointers.
function readName(buf, off) {
  const labels = []
  let jumped = false
  let past = off
  for (let guard = 0; guard < 128; guard++) {
    const len = buf[off]
    if (len === undefined) break
    if (len === 0) {
      off++
      break
    }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) {
        past = off + 2
        jumped = true
      }
      off = ((len & 0x3f) << 8) | buf[off + 1]
      continue
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len))
    off += 1 + len
  }
  return [labels.join('.'), jumped ? past : off]
}

function parseRecords(buf) {
  const rrs = []
  let off = 12
  const qdcount = buf.readUInt16BE(4)
  const sections = [buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)]

  for (let i = 0; i < qdcount; i++) {
    const [, next] = readName(buf, off)
    off = next + 4
  }
  for (const count of sections) {
    for (let i = 0; i < count; i++) {
      const [name, next] = readName(buf, off)
      off = next
      const type = buf.readUInt16BE(off)
      off += 2 + 2 + 4 // class, ttl
      const rdlen = buf.readUInt16BE(off)
      off += 2
      rrs.push({ name, type, rdstart: off, rdata: buf.subarray(off, off + rdlen) })
      off += rdlen
    }
  }
  return rrs
}

function parseTxt(rdata) {
  const txt = {}
  let p = 0
  while (p < rdata.length) {
    const len = rdata[p++]
    const entry = rdata.toString('utf8', p, p + len)
    p += len
    const eq = entry.indexOf('=')
    if (eq > 0) txt[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return txt
}

/**
 * Browse a service type, e.g. '_googlecast._tcp.local'.
 * Resolves to [{ instance, name, host, ip, port, txt }].
 */
export async function discover(service, timeoutMs = 3000) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const devices = new Map()
  const addresses = new Map()

  sock.on('message', (msg) => {
    let rrs
    try {
      rrs = parseRecords(msg)
    } catch {
      return // a malformed packet from some other device on the LAN
    }
    for (const rr of rrs) {
      if (rr.type === TYPE_A && rr.rdata.length === 4) {
        addresses.set(rr.name, Array.from(rr.rdata).join('.'))
        continue
      }
      if (!rr.name.endsWith(service)) continue

      const dev = devices.get(rr.name) ?? { instance: rr.name }
      if (rr.type === TYPE_SRV) {
        dev.port = rr.rdata.readUInt16BE(4)
        dev.host = readName(msg, rr.rdstart + 6)[0]
      } else if (rr.type === TYPE_TXT) {
        dev.txt = parseTxt(rr.rdata)
      } else if (rr.type === TYPE_PTR) {
        // The PTR's name is the service; its target is the instance.
        const target = readName(msg, rr.rdstart)[0]
        if (!devices.has(target)) devices.set(target, { instance: target })
        continue
      }
      devices.set(rr.name, dev)
    }
  })

  sock.bind(0)
  await once(sock, 'listening')

  const query = buildQuery(service, TYPE_PTR)
  const send = () => sock.send(query, MDNS_PORT, MDNS_ADDR, () => {})
  send()
  const retries = [400, 1200].map((d) => setTimeout(send, d))

  await new Promise((r) => setTimeout(r, timeoutMs))
  retries.forEach(clearTimeout)
  sock.close()

  return [...devices.values()]
    .filter((d) => d.port)
    .map((d) => ({
      ...d,
      ip: addresses.get(d.host) ?? null,
      name: d.txt?.fn ?? d.instance.split('.')[0],
    }))
}
