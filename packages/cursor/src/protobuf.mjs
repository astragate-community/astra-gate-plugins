// Protobuf by hand, and Connect's frames.
import { EMPTY } from "./constants.mjs"
import { gunzipSync } from "node:zlib"

class PB {
  parts = []
  push(b) {
    this.parts.push(b)
    return this
  }
  uv(v) {
    const out = []
    while (v >= 0x80) {
      out.push((v % 128) | 0x80)
      v = Math.floor(v / 128)
    }
    out.push(v)
    return this.push(Uint8Array.from(out))
  }
  tag(num, wire) {
    return this.uv(num * 8 + wire)
  }
  varint(num, v) {
    return this.tag(num, 0).uv(v)
  }
  bytes(num, v) {
    const b = v instanceof PB ? v.done() : v ?? EMPTY
    return this.tag(num, 2).uv(b.length).push(b)
  }
  str(num, s) {
    return this.bytes(num, Buffer.from(s, "utf8"))
  }
  double(num, v) {
    const b = Buffer.alloc(8)
    b.writeDoubleLE(v)
    return this.tag(num, 1).push(b)
  }
  done() {
    return Buffer.concat(this.parts)
  }
}
export const pb = () => new PB()

// fields reads a message's fields; a malformed tail is dropped.
export function fields(b) {
  b = Buffer.isBuffer(b) ? b : Buffer.from(b ?? EMPTY)
  const out = []
  let i = 0
  const uv = () => {
    let v = 0
    let m = 1
    while (i < b.length) {
      const c = b[i++]
      v += (c & 0x7f) * m
      if (c < 0x80) return v
      m *= 128
    }
    return -1
  }
  while (i < b.length) {
    const key = uv()
    if (key < 0) break
    const f = { num: Math.floor(key / 8), wire: key % 8, n: 0, data: EMPTY }
    switch (f.wire) {
      case 0: {
        const v = uv()
        if (v < 0) return out
        f.n = v
        break
      }
      case 1:
        if (i + 8 > b.length) return out
        f.data = b.subarray(i, i + 8)
        f.n = Number(b.readBigUInt64LE(i))
        i += 8
        break
      case 2: {
        const l = uv()
        if (l < 0 || i + l > b.length) return out
        f.data = b.subarray(i, i + l)
        i += l
        break
      }
      case 5:
        if (i + 4 > b.length) return out
        f.n = b.readUInt32LE(i)
        i += 4
        break
      default:
        return out
    }
    out.push(f)
  }
  return out
}

export const field = (fs, num) => fs.find((f) => f.num === num)
export const pbStr = (fs, num) => field(fs, num)?.data.toString("utf8") ?? ""
export const pbNum = (fs, num) => field(fs, num)?.n ?? 0

// pbValue is a google.protobuf.Value.
export function pbValue(v) {
  if (v === null || v === undefined) return pb().varint(1, 0)
  if (typeof v === "number") return pb().double(2, v)
  if (typeof v === "string") return pb().str(3, v)
  if (typeof v === "boolean") return pb().varint(4, v ? 1 : 0)
  if (Array.isArray(v)) {
    const l = pb()
    for (const e of v) l.bytes(1, pbValue(e))
    return pb().bytes(6, l)
  }
  if (typeof v === "object") {
    const st = pb()
    for (const k of Object.keys(v).sort()) st.bytes(1, pb().str(1, k).bytes(2, pbValue(v[k])))
    return pb().bytes(5, st)
  }
  return pb().varint(1, 0)
}

// mapOf reads the map entries among a message's fields numbered num: each a key (1) and a Value (2).
export function mapOf(fs, num) {
  const out = {}
  for (const e of fs) {
    if (e.num !== num) continue
    const kv = fields(e.data)
    const v = field(kv, 2)
    out[pbStr(kv, 1)] = v ? pbAny(v.data) : null
  }
  return out
}

// pbAny reads a google.protobuf.Value.
export function pbAny(b) {
  for (const f of fields(b)) {
    switch (f.num) {
      case 1:
        return null
      case 2:
        return f.data.length === 8 ? f.data.readDoubleLE(0) : 0
      case 3:
        return f.data.toString("utf8")
      case 4:
        return f.n !== 0
      case 5:
        return mapOf(fields(f.data), 1)
      case 6:
        return fields(f.data).filter((e) => e.num === 1).map((e) => pbAny(e.data))
    }
  }
  return null
}

// frame wraps a message as one frame of a Connect stream.
export function frame(msg) {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(msg.length, 1)
  return Buffer.concat([head, msg])
}

// frames reads a Connect stream's frames: a message, or the stream's end
// with its JSON.
export async function* frames(body) {
  let buf = EMPTY
  for await (const chunk of body) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk)
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(1)
      if (n > 64 << 20) throw new Error("a malformed stream")
      if (buf.length < 5 + n) break
      const flags = buf[0]
      let data = buf.subarray(5, 5 + n)
      buf = buf.subarray(5 + n)
      if (flags & 1) data = gunzipSync(data)
      yield { end: (flags & 2) !== 0, data }
    }
  }
  if (buf.length) throw new Error("unexpected EOF")
}
