// Protobuf by hand, and Connect's frames (the v1 plugin's protobuf.mjs on Uint8Array: the sandbox has no Buffer).
export const EMPTY = new Uint8Array(0);
const te = new TextEncoder();
const td = new TextDecoder();

export const utf8 = (s) => te.encode(String(s));
export const text = (b) => td.decode(b ?? EMPTY);

/** The bytes of several parts, one after another. */
export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

class PB {
  parts = [];
  push(b) {
    this.parts.push(b);
    return this;
  }
  uv(v) {
    const out = [];
    while (v >= 0x80) {
      out.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return this.push(Uint8Array.from(out));
  }
  tag(num, wire) {
    return this.uv(num * 8 + wire);
  }
  varint(num, v) {
    return this.tag(num, 0).uv(v);
  }
  bytes(num, v) {
    const b = v instanceof PB ? v.done() : v ?? EMPTY;
    return this.tag(num, 2).uv(b.length).push(b);
  }
  str(num, s) {
    return this.bytes(num, utf8(s));
  }
  double(num, v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    return this.tag(num, 1).push(b);
  }
  done() {
    return concat(this.parts);
  }
}
export const pb = () => new PB();

/** A message's fields; a malformed tail is dropped. */
export function fields(b) {
  b = b ?? EMPTY;
  const out = [];
  let i = 0;
  const uv = () => {
    let v = 0;
    let m = 1;
    while (i < b.length) {
      const c = b[i++];
      v += (c & 0x7f) * m;
      if (c < 0x80) return v;
      m *= 128;
    }
    return -1;
  };
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (i < b.length) {
    const key = uv();
    if (key < 0) break;
    const f = { num: Math.floor(key / 8), wire: key % 8, n: 0, data: EMPTY };
    switch (f.wire) {
      case 0: {
        const v = uv();
        if (v < 0) return out;
        f.n = v;
        break;
      }
      case 1:
        if (i + 8 > b.length) return out;
        f.data = b.subarray(i, i + 8);
        f.n = Number(view.getBigUint64(i, true));
        i += 8;
        break;
      case 2: {
        const l = uv();
        if (l < 0 || i + l > b.length) return out;
        f.data = b.subarray(i, i + l);
        i += l;
        break;
      }
      case 5:
        if (i + 4 > b.length) return out;
        f.n = view.getUint32(i, true);
        i += 4;
        break;
      default:
        return out;
    }
    out.push(f);
  }
  return out;
}

export const field = (fs, num) => fs.find((f) => f.num === num);
export const pbStr = (fs, num) => {
  const f = field(fs, num);
  return f ? text(f.data) : '';
};
export const pbNum = (fs, num) => field(fs, num)?.n ?? 0;

/** A google.protobuf.Value. */
export function pbValue(v) {
  if (v === null || v === undefined) return pb().varint(1, 0);
  if (typeof v === 'number') return pb().double(2, v);
  if (typeof v === 'string') return pb().str(3, v);
  if (typeof v === 'boolean') return pb().varint(4, v ? 1 : 0);
  if (Array.isArray(v)) {
    const l = pb();
    for (const e of v) l.bytes(1, pbValue(e));
    return pb().bytes(6, l);
  }
  if (typeof v === 'object') {
    const st = pb();
    for (const k of Object.keys(v).sort()) st.bytes(1, pb().str(1, k).bytes(2, pbValue(v[k])));
    return pb().bytes(5, st);
  }
  return pb().varint(1, 0);
}

/** The map entries among a message's fields numbered num: each a key (1) and a Value (2). */
export function mapOf(fs, num) {
  const out = {};
  for (const e of fs) {
    if (e.num !== num) continue;
    const kv = fields(e.data);
    const v = field(kv, 2);
    out[pbStr(kv, 1)] = v ? pbAny(v.data) : null;
  }
  return out;
}

/** Reads a google.protobuf.Value. */
export function pbAny(b) {
  for (const f of fields(b)) {
    switch (f.num) {
      case 1:
        return null;
      case 2:
        return f.data.length === 8 ? new DataView(f.data.buffer, f.data.byteOffset, 8).getFloat64(0, true) : 0;
      case 3:
        return text(f.data);
      case 4:
        return f.n !== 0;
      case 5:
        return mapOf(fields(f.data), 1);
      case 6:
        return fields(f.data).filter((e) => e.num === 1).map((e) => pbAny(e.data));
    }
  }
  return null;
}

/** A message as one frame of a Connect stream (flags 0). */
export function frame(msg) {
  const out = new Uint8Array(5 + msg.length);
  new DataView(out.buffer).setUint32(1, msg.length, false);
  out.set(msg, 5);
  return out;
}
