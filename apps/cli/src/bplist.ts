// Minimal binary plist writer for a flat dict of strings and numbers.
// Apple TV /play wants application/x-apple-binary-plist, not XML.

const HEADER = new TextEncoder().encode("bplist00")

const u8 = (n: number): Uint8Array => Uint8Array.of(n & 0xff)

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

const writeInt = (n: number, size: number): Uint8Array => {
  const out = new Uint8Array(size)
  for (let i = size - 1; i >= 0; i--) {
    out[i] = n & 0xff
    n = Math.floor(n / 256)
  }
  return out
}

const writeAscii = (s: string): Uint8Array => {
  const bytes = new TextEncoder().encode(s)
  const marker =
    bytes.byteLength < 15 ? u8(0x50 | bytes.byteLength) : concat([u8(0x5f), u8(0x10 | 1), writeInt(bytes.byteLength, 1)])
  // for our sizes always < 15 is false (URLs are long). use int length.
  if (bytes.byteLength < 15) {
    return concat([u8(0x50 | bytes.byteLength), bytes])
  }
  return concat([u8(0x5f), u8(0x11), writeInt(bytes.byteLength, 2), bytes])
}

const writeReal = (n: number): Uint8Array => {
  const buf = new ArrayBuffer(8)
  new DataView(buf).setFloat64(0, n, false)
  return concat([u8(0x23), new Uint8Array(buf)])
}

export const encode = (dict: Record<string, string | number>): Uint8Array => {
  const keys = Object.keys(dict)
  const objects: Uint8Array[] = []
  // object 0 is the dict
  const keyRefs: number[] = []
  const valRefs: number[] = []
  for (const key of keys) {
    keyRefs.push(objects.length + 1)
    objects.push(writeAscii(key))
    const value = dict[key]
    valRefs.push(objects.length + 1)
    objects.push(typeof value === "number" ? writeReal(value) : writeAscii(String(value)))
  }
  const dictCount = keys.length
  const dictMarker =
    dictCount < 15 ? u8(0xd0 | dictCount) : concat([u8(0xdf), u8(0x11), writeInt(dictCount, 2)])
  const dictObj = concat([dictMarker, ...keyRefs.map((r) => u8(r)), ...valRefs.map((r) => u8(r))])
  const all = [dictObj, ...objects]
  const offsetSize = 1
  const refSize = 1
  const offsets: number[] = []
  let cursor = 8
  const bodyParts: Uint8Array[] = []
  for (const obj of all) {
    offsets.push(cursor)
    bodyParts.push(obj)
    cursor += obj.byteLength
  }
  const offsetTableOffset = cursor
  const offsetTable = concat(offsets.map((o) => writeInt(o, offsetSize)))
  const trailer = concat([
    new Uint8Array(6),
    u8(offsetSize),
    u8(refSize),
    writeInt(0, 4),
    writeInt(all.length, 4),
    writeInt(0, 4),
    writeInt(0, 4),
    writeInt(0, 4),
    writeInt(offsetTableOffset, 4)
  ])
  // trailer is 32 bytes: 6 unused, offsetSize, refSize, 8 num objects, 8 top object, 8 offset table offset
  const trailer32 = new Uint8Array(32)
  trailer32[6] = offsetSize
  trailer32[7] = refSize
  new DataView(trailer32.buffer).setUint32(12, all.length, false)
  new DataView(trailer32.buffer).setUint32(20, 0, false)
  new DataView(trailer32.buffer).setUint32(28, offsetTableOffset, false)
  return concat([HEADER, ...bodyParts, offsetTable, trailer32])
}
