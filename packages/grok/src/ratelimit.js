// Grok's billing says nothing of a plan's rate limit: a free account's credits read 0% used while every request comes back
// 429. So the account's last 429 is kept here, by account, and usage shows a "Rate limit" window spent until the reset the
// 429 named (Retry-After, or a *ratelimit*reset* header), or, when it named none, until a request goes through or HOLD_MS
// has passed. Aside: the gateway already rests an account that answered 429; this is only what the card says. (A cache that
// is lost with the plugin's engine, which only means the card forgets.)
export const HOLD_MS = 5 * 60_000;
export const limited = new Map();

// the headers of the reply as the host gives them: a plain object, names lowercase, but be loose about it
const header = (headers, name) => {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return v;
  return undefined;
};

/** When a 429 says the limit lifts, in ms since the epoch, or 0. */
export function resetOf(headers, now) {
  const ra = header(headers, 'retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n >= 0) return now + n * 1000;
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) return d;
  }
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (!/ratelimit.*reset/i.test(k)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    // a time (epoch ms or seconds) or seconds from now
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return now + n * 1000;
  }
  return 0;
}

/** Keeps what a request's answer says of the rate limit. */
export function note(account, status, headers, now = Date.now()) {
  if (!account) return;
  if (status === 429) limited.set(account, { at: now, until: resetOf(headers, now) });
  else if (status >= 200 && status < 300) limited.delete(account);
}

/** The window a recent 429 makes, or none. */
export function rateWindow(account, now = Date.now()) {
  const l = limited.get(account);
  if (!l) return [];
  if (l.until ? l.until <= now : now - l.at >= HOLD_MS) {
    limited.delete(account);
    return [];
  }
  const end = l.until || l.at + HOLD_MS;
  return [{ name: 'Rate limit', used: 100, resetsAt: new Date(end).toISOString(), aside: true }];
}
