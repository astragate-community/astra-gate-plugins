// Qoder: the body codec the model API's request bodies travel in.

// Base64 through the client's shuffled alphabet ('$' pads), then the first
// and last thirds swapped.
const ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"

function segmentEncode(bytes) {
  let s = ""
  let acc = 0
  let nb = 0
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffffff
    nb += 8
    while (nb >= 6) {
      nb -= 6
      s += ALPHABET[(acc >> nb) & 63]
    }
  }
  if (nb > 0) s += ALPHABET[(acc << (6 - nb)) & 63]
  while (s.length % 4) s += "$"
  return s
}

function swapThirds(s) {
  const t = Math.floor(s.length / 3)
  return t ? s.slice(s.length - t) + s.slice(t, s.length - t) + s.slice(0, t) : s
}

export const encodeBody = (text) => swapThirds(segmentEncode(Buffer.from(text, "utf8")))

export function decodeBody(wire) {
  const s = swapThirds(wire)
  const out = []
  for (let g = 0; g + 4 <= s.length; g += 4) {
    const vals = [...s.slice(g, g + 4)].filter((c) => c !== "$").map((c) => ALPHABET.indexOf(c))
    let x = 0
    for (const v of vals) x = x * 64 + v
    const n = Math.floor((6 * vals.length) / 8)
    for (let k = 0; k < n; k++) out.push(Math.floor(x / 2 ** (6 * vals.length - 8 * (k + 1))) & 255)
  }
  return Buffer.from(out).toString("utf8")
}
