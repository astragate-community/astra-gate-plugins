// Protobuf and Connect framing, by hand: just what GetChatMessage and its neighbours need.
import { gunzipSync } from "node:zlib"

export const enc = new TextEncoder()
export const dec = new TextDecoder()

// pb builds a protobuf message field by field.
export class PB {
  constructor() {
    this.parts = []
  }
  uvarint(n) {
    const b = []
    n = BigInt(n)
    while (n >= 0x80n) {
      b.push(Number(n & 0x7fn) | 0x80)
      n >>= 7n
    }
    b.push(Number(n))
    this.parts.push(Uint8Array.from(b))
  }
  varint(num, v) {
    this.uvarint((num << 3) | 0)
    this.uvarint(v)
    return this
  }
  bytes(num, v) {
    if (typeof v === "string") v = enc.encode(v)
    else if (v instanceof PB) v = v.done()
    this.uvarint((num << 3) | 2)
    this.uvarint(v.length)
    this.parts.push(v)
    return this
  }
  str(num, v) {
    return this.bytes(num, v)
  }
  double(num, v) {
    this.uvarint((num << 3) | 1)
    const b = new Uint8Array(8)
    new DataView(b.buffer).setFloat64(0, v, true)
    this.parts.push(b)
    return this
  }
  done() {
    const n = this.parts.reduce((s, p) => s + p.length, 0)
    const out = new Uint8Array(n)
    let at = 0
    for (const p of this.parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }
}

// fields reads a message's fields; a malformed tail is dropped.
export function fields(b) {
  const out = []
  let i = 0
  const uvarint = () => {
    let n = 0n
    let shift = 0n
    for (;;) {
      if (i >= b.length) return null
      const c = b[i++]
      n |= BigInt(c & 0x7f) << shift
      if (!(c & 0x80)) return n
      shift += 7n
    }
  }
  while (i < b.length) {
    const key = uvarint()
    if (key === null) break
    const f = { num: Number(key >> 3n), wire: Number(key & 7n), n: 0, data: null }
    if (f.wire === 0) {
      const v = uvarint()
      if (v === null) break
      f.n = Number(v)
    } else if (f.wire === 1) {
      if (i + 8 > b.length) break
      i += 8
    } else if (f.wire === 2) {
      const l = uvarint()
      if (l === null || i + Number(l) > b.length) break
      f.data = b.subarray(i, i + Number(l))
      i += Number(l)
    } else if (f.wire === 5) {
      if (i + 4 > b.length) break
      i += 4
    } else break
    out.push(f)
  }
  return out
}

// frame wraps a message as the one frame of a Connect stream.
export function frame(msg) {
  const out = new Uint8Array(5 + msg.length)
  new DataView(out.buffer).setUint32(1, msg.length)
  out.set(msg, 5)
  return out
}

// frames reads a Connect stream: each message, or its end with its JSON.
export async function* frames(body) {
  let buf = new Uint8Array(0)
  const reader = body.getReader()
  try {
    for (;;) {
      while (buf.length >= 5) {
        const n = new DataView(buf.buffer, buf.byteOffset).getUint32(1)
        if (n > 64 << 20) throw new Error("a malformed stream")
        if (buf.length < 5 + n) break
        const flags = buf[0]
        let data = buf.slice(5, 5 + n)
        buf = buf.slice(5 + n)
        if (flags & 1) data = new Uint8Array(gunzipSync(data))
        yield { end: !!(flags & 2), data }
      }
      const { value, done } = await reader.read()
      if (done) {
        if (buf.length) throw new Error("unexpected EOF")
        return
      }
      const next = new Uint8Array(buf.length + value.length)
      next.set(buf)
      next.set(value, buf.length)
      buf = next
    }
  } finally {
    reader.releaseLock()
  }
}
