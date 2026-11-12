// Xiaomi MiMo: a cookie jar, enough for the sign-on's redirects, and the walk through them. The host keeps no jar and
// follows no redirect for a `manual` fetch: each hop is asked here with the jar's `cookie` header, and the hop's
// `res.setCookies` lines go back into the jar.
import { http } from 'astra';
import { ACCOUNT } from './constants.js';
import { header } from './util.js';

export class Jar {
  constructor() {
    this.cookies = [];
  }
  put(c) {
    this.cookies = this.cookies.filter((o) => !(o.name === c.name && o.domain === c.domain && o.path === c.path));
    if (!c.gone) this.cookies.push(c);
  }
  seed(url, name, value) {
    this.put({ name, value, domain: new URL(url).hostname.toLowerCase(), hostOnly: false, path: '/', secure: false });
  }
  /** Takes the Set-Cookie lines (`res.setCookies`) of a reply to `url`. */
  take(lines, url) {
    const u = new URL(url);
    for (const line of lines ?? []) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const c = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: u.hostname.toLowerCase(), hostOnly: true, secure: false };
      const dir = u.pathname.lastIndexOf('/');
      c.path = dir > 0 ? u.pathname.slice(0, dir) : '/';
      for (const a of attrs) {
        const i = a.indexOf('=');
        const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
        const v = i < 0 ? '' : a.slice(i + 1).trim();
        if (k === 'domain' && v) {
          const d = v.replace(/^\./, '').toLowerCase();
          if (c.domain === d || c.domain.endsWith('.' + d)) Object.assign(c, { domain: d, hostOnly: false });
        } else if (k === 'path' && v.startsWith('/')) c.path = v;
        else if (k === 'secure') c.secure = true;
        else if (k === 'max-age' && Number(v) <= 0) c.gone = true;
        else if (k === 'expires' && Date.parse(v) <= Date.now()) c.gone = true;
      }
      this.put(c);
    }
  }
  for(url) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return this.cookies.filter((c) => {
      if (c.secure && u.protocol !== 'https:') return false;
      if (c.hostOnly ? host !== c.domain : host !== c.domain && !host.endsWith('.' + c.domain)) return false;
      return u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/') || c.path === '/';
    });
  }
  header(url) {
    return this.for(url)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
}

/** A session as a Cookie header, in a steady order. */
export function cookieHeader(cookies) {
  const first = ['serviceToken', 'userId', 'cUserId'];
  const parts = first.filter((k) => k in cookies).map((k) => `${k}=${cookies[k]}`);
  for (const [k, v] of Object.entries(cookies)) if (!first.includes(k)) parts.push(`${k}=${v}`);
  return parts.join('; ');
}

/** A jar holding the Xiaomi account's own cookies: what the passToken signs on with. */
export function accountJar(creds) {
  const jar = new Jar();
  for (const [k, v] of [['userId', creds.userId], ['passToken', creds.passToken], ['cUserId', creds.cUserId], ['deviceId', creds.deviceId], ['pass_ua', 'pc'], ['uLocale', 'zh_CN']]) {
    if (v) jar.seed(ACCOUNT, k, v);
  }
  return jar;
}

/** The time left of a `budget` (ms from `started`), as a fetch timeout; throws once it is gone. */
export function leftOf(started, budget, what = 'the sign-in') {
  const left = budget - (Date.now() - started);
  if (left < 300) throw new Error(`Xiaomi MiMo: ${what} ran out of time`);
  return Math.min(left, 30_000);
}

/**
 * Asks `start` and follows its redirects by hand (`redirect: 'manual'`), the jar keeping the cookies they set and sending
 * them back; gives the last response (its body not yet read) and the url it came from. `home` is the server whose http://
 * followups are asked over https; `failed` words a fetch that threw; `budget` is all the time the walk may take.
 */
export async function follow(jar, start, { headers = {}, home, tooMany, failed, budget = 30_000 }) {
  const homeUrl = new URL(home);
  const started = Date.now();
  let url = start;
  for (let hop = 0; ; hop++) {
    if (hop > 10) throw new Error(tooMany);
    const h = { ...headers };
    const cookie = jar.header(url);
    if (cookie) h.cookie = cookie;
    let res;
    try {
      res = await http.fetch(url, { headers: h, redirect: 'manual', timeoutMs: leftOf(started, budget) });
    } catch (e) {
      throw failed ? failed(e) : e;
    }
    jar.take(res.setCookies, url);
    const loc = header(res, 'location');
    if (res.status < 300 || res.status >= 400 || !loc) return { res, url };
    await res.bytes().catch(() => {});
    const next = new URL(loc, url);
    // the server's followup is written http://; its session cookies are only sent back over https
    if (next.protocol === 'http:' && homeUrl.protocol === 'https:' && next.host.toLowerCase() === homeUrl.host.toLowerCase()) next.protocol = 'https:';
    url = next.href;
  }
}
