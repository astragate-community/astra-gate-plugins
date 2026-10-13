// Trae: reading the loose values its answers carry (JSON in a string, expiry times, a JWT's exp).

// whenOf reads one of Trae's expiry times: seconds, milliseconds or ISO
export function whenOf(v) {
  if (v === undefined || v === null || v === "") return 0
  if (typeof v === "string" && !/^\d+$/.test(v.trim())) {
    const t = Date.parse(v)
    return isNaN(t) ? 0 : t
  }
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e11 ? n * 1000 : n
}

// jwtExp is a JWT's exp, in ms, 0 when it has none
export function jwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString())
    return whenOf(p?.exp)
  } catch {
    return 0
  }
}

export const parseJSON = (s) => {
  if (s && typeof s === "object") return s
  try {
    const v = JSON.parse(String(s ?? ""))
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}
