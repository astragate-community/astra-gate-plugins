// Kiro: reading an AWS event stream.
import { tryJSON } from "./errors.mjs"

// frames reads an AWS event stream: each message its length, its headers'
// length and a checksum, the headers, the payload, a checksum of the whole.
export async function* frames(body) {
  let buf = new Uint8Array(0)
  const reader = body.getReader()
  try {
    for (;;) {
      while (buf.length >= 12) {
        const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
        const total = v.getUint32(0)
        const hlen = v.getUint32(4)
        if (total < 16 || total > 16 << 20 || hlen > total - 16) throw new Error("a malformed event stream")
        if (buf.length < total) break
        const rest = buf.subarray(12, total)
        yield { headers: frameHeaders(rest.subarray(0, hlen)), payload: rest.subarray(hlen, rest.length - 4) }
        buf = buf.slice(total)
      }
      const { value, done } = await reader.read()
      if (done) {
        if (buf.length) throw new Error("unexpected EOF")
        return
      }
      const n = new Uint8Array(buf.length + value.length)
      n.set(buf)
      n.set(value, buf.length)
      buf = n
    }
  } finally {
    reader.releaseLock?.()
  }
}

// the byte size of each fixed-size header value type (6 and 7 are length-prefixed: bytes, string)
const VALUE_SIZES = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }

// frameHeaders reads a message's headers: the string ones, by name.
export function frameHeaders(h) {
  const out = {}
  const dec = new TextDecoder()
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength)
  let i = 0
  while (i < h.length) {
    const n = h[i]
    if (h.length < i + 2 + n) break
    const name = dec.decode(h.subarray(i + 1, i + 1 + n))
    const type = h[i + 1 + n]
    i += 2 + n
    const size = VALUE_SIZES[type]
    if (type === 6 || type === 7) {
      if (h.length < i + 2) break
      const l = v.getUint16(i)
      if (h.length < i + 2 + l) break
      if (type === 7) out[name] = dec.decode(h.subarray(i + 2, i + 2 + l))
      i += 2 + l
      continue
    }
    if (size === undefined || h.length < i + size) break
    i += size
  }
  return out
}

// exception is what an error in the stream says.
export function exception(kind, payload) {
  const e = tryJSON(new TextDecoder().decode(payload)) ?? {}
  let msg = e.message || e.Message || new TextDecoder().decode(payload).trim()
  if (e.reason) msg += ` (${e.reason})`
  if (String(kind).toLowerCase().includes("throttl")) return "rate limited: " + msg
  return kind ? `${kind}: ${msg}` : msg
}
