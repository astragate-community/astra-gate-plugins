// Grok's billing says nothing of a plan's rate limit: a free account's
// credits read 0% used while every request comes back 429. So the account's
// last 429 is kept here, by its CLI home, and usage shows a "Rate limit"
// window spent until the reset the 429 named (Retry-After, or a
// *ratelimit*reset* header), or, when it named none, until a request goes
// through or HOLD_MS has passed. Aside: magpie's gateway already rests an
// account that answered 429; this is only what the card says.
export const HOLD_MS = 5 * 60_000
export const limited = new Map()

// resetOf is when a 429 says the limit lifts, in ms since the epoch, or 0.
export function resetOf(headers, now) {
  const ra = headers.get("retry-after")
  if (ra) {
    const n = Number(ra)
    if (Number.isFinite(n) && n >= 0) return now + n * 1000
    const d = Date.parse(ra)
    if (!Number.isNaN(d)) return d
  }
  for (const [k, v] of headers) {
    if (!/ratelimit.*reset/i.test(k)) continue
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) continue
    // a time (epoch ms or seconds) or seconds from now
    if (n > 1e12) return n
    if (n > 1e9) return n * 1000
    return now + n * 1000
  }
  return 0
}

// note keeps what a request's answer says of the rate limit.
export function note(home, res, now = Date.now()) {
  if (res.status === 429) limited.set(home, { at: now, until: resetOf(res.headers, now) })
  else if (res.ok) limited.delete(home)
}

// rateWindow is the window a recent 429 makes, or none.
export function rateWindow(home, now = Date.now()) {
  const l = limited.get(home)
  if (!l) return []
  if (l.until ? l.until <= now : now - l.at >= HOLD_MS) {
    limited.delete(home)
    return []
  }
  const end = l.until || l.at + HOLD_MS
  return [{ name: "Rate limit", used: 100, resetsAt: new Date(end).toISOString(), aside: true }]
}
