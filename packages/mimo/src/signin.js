// Xiaomi MiMo: signing in at account.xiaomi.com's long-poll page (a QR code for the Xiaomi phone app, or the password).
import { http, crypto, encoding, timers } from 'astra';
import { ACCOUNT, HOSTS, REGION, SIGN_IN_LIFE, SLOW_BUDGET, UA, appHeaders, baseOf } from './constants.js';
import { header, Lapsed, tryJSON } from './util.js';
import { session } from './sso.js';

export const deviceId = () => 'pc_' + encoding.hex.encode(crypto.randomBytes(16));

// the account server's JSON comes after a "&&&START&&&" guard
const accountJSON = (text) => tryJSON(text.trim().replace(/^&&&START&&&/, '')) ?? null;

// the sid and callback the MiMo server sends a browser with no session to account.xiaomi.com with
async function serviceOf(base) {
  let sid = 'mimosgp';
  let callback = base.replace(/\/+$/, '') + '/sts';
  try {
    const res = await http.fetch(base.replace(/\/+$/, '') + '/user/xiaomi/me', { headers: appHeaders(), redirect: 'manual', timeoutMs: 15_000 });
    const loc = header(res, 'location');
    if (loc) {
      const q = new URL(loc, base).searchParams;
      sid = q.get('sid') || sid;
      callback = q.get('callback') || callback;
    }
  } catch {}
  return { sid, callback };
}

async function accountGet(url, device, timeoutMs) {
  const res = await http.fetch(url, { headers: { 'user-agent': UA, cookie: `deviceId=${device}; pass_ua=pc; uLocale=zh_CN` }, timeoutMs });
  return { status: res.status, text: await res.text() };
}

/** Asks Xiaomi for a sign-in page: { url (to open, or a QR), lp (the long poll), device, until }. */
export async function startSignIn() {
  const base = HOSTS[REGION];
  const device = deviceId();
  const { sid, callback } = await serviceOf(base);
  const q = new URLSearchParams({
    _group: 'DEFAULT',
    _qrsize: '240',
    qs: '%3Fsid%3D' + encodeURIComponent(sid) + '%26_json%3Dtrue',
    callback,
    _hasLogo: 'false',
    sid,
    serviceParam: '',
    _locale: 'en_US',
  });
  const { status, text } = await accountGet(`${ACCOUNT}/longPolling/loginUrl?${q}`, device, 20_000);
  const lp = accountJSON(text);
  if (!lp || lp.code !== 0 || !lp.loginUrl || !lp.lp) {
    throw new Error(`Xiaomi MiMo sign-in: account.xiaomi.com answered ${status} ${lp?.desc || text.trim().slice(0, 200)}`);
  }
  const life = lp.timeout > 0 ? Math.min(lp.timeout * 1000, SIGN_IN_LIFE) : SIGN_IN_LIFE;
  return { url: lp.loginUrl, lp: lp.lp, device, until: Date.now() + life };
}

/**
 * Asks the ticket's long poll for up to `sliceMs` (a view action has a wall-clock limit): the sign-in's payload
 * ({ userId, passToken, … }) once Xiaomi says the account is in, null when the slice ended first. Throws when the page's
 * life is over.
 */
export async function pollSlice(t, sliceMs) {
  const end = Date.now() + sliceMs;
  while (Date.now() < end) {
    if (Date.now() >= t.until) throw new Error('the Xiaomi sign-in page expired before the sign-in finished; start it again');
    try {
      const left = end - Date.now();
      const { status, text } = await accountGet(t.lp, t.device, Math.min(70_000, Math.max(left, 1000)));
      const p = status === 200 ? accountJSON(text) : null;
      if (p?.passToken && String(p.userId ?? '')) return p;
    } catch {}
    if (Date.now() < end) await timers.sleep(1000);
  }
  if (Date.now() >= t.until) throw new Error('the Xiaomi sign-in page expired before the sign-in finished; start it again');
  return null;
}

/** The poll's payload as a signed-in account: its creds and the MiMo session, served by the region the account belongs to. */
export async function signedInWith(p, device) {
  let creds = { userId: String(p.userId), cUserId: p.cUserId ?? '', passToken: p.passToken, deviceId: device, region: REGION, base: HOSTS[REGION] };
  let s;
  try {
    s = await session(creds, creds.base, SLOW_BUDGET);
  } catch (e) {
    if (e instanceof Lapsed) throw new Error("Xiaomi signed the account in, but the MiMo server didn't take it; try again");
    throw e;
  }
  // an account of another region is served by that region's server
  const r = String(s.me?.region ?? '').trim().toUpperCase();
  const nb = baseOf(r);
  if (r && r !== creds.region && nb && nb !== creds.base) {
    try {
      s = await session(creds, nb, SLOW_BUDGET);
      creds = { ...creds, region: r, base: nb };
    } catch {}
  }
  return { creds: { ...creds, userId: String(s.me?.userId ?? '') || creds.userId }, cookies: s.cookies };
}
