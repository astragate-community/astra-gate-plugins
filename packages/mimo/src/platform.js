// Xiaomi MiMo: the open platform's Token Plan — its pages, its plan and its tp- key — read with the Xiaomi account.
import { http } from 'astra';
import { ACCOUNT, PLATFORM, TP_LIFE } from './constants.js';
import { accountJar, cookieHeader, follow, leftOf } from './cookies.js';
import { statusLine, tryJSON, vendorError } from './util.js';

/** A count of the Token Plan's credits, short: 6.81M, 4.1B. */
export function credits(n) {
  for (const [d, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (n >= d) return `${Number((n / d).toPrecision(3))}${u}`;
  }
  return String(n);
}

/**
 * One of the platform's /api/v1 pages, as { cookies, data }: cookies the session it was read with (given in, else signed on
 * afresh), data the page's. The same Xiaomi account signs on at the platform as at the MiMo server: a page asked with no
 * session answers 401 with a serviceLogin URL (sid api-platform), which the passToken follows back through the platform's
 * /sts to the page.
 */
export async function platformPage(creds, path, cookies, budget = 20_000) {
  const started = Date.now();
  const url = PLATFORM + '/api/v1' + path;
  const ask = async (c) => {
    const res = await http.fetch(url, { headers: c ? { cookie: c } : {}, redirect: 'manual', timeoutMs: leftOf(started, budget, 'the platform read') });
    return { res, text: await res.text() };
  };
  const data = (text) => {
    const v = tryJSON(text);
    return v?.code === 0 ? (v.data ?? null) : undefined;
  };
  if (cookies) {
    const { res, text } = await ask(cookieHeader(cookies));
    const d = res.status === 200 ? data(text) : undefined;
    if (d !== undefined) return { cookies, data: d };
  }
  const first = await ask('');
  const login = tryJSON(first.text)?.loginUrl;
  if (first.res.status !== 401 || typeof login !== 'string' || !login.startsWith(ACCOUNT + '/')) {
    throw new Error(`Xiaomi MiMo platform ${path}: ${vendorError(first.text, statusLine(first.res.status))}`);
  }
  const jar = accountJar(creds);
  const { res } = await follow(jar, login, { home: PLATFORM, tooMany: 'Xiaomi MiMo platform sign-in: too many redirects', budget: Math.max(500, budget - (Date.now() - started)) });
  const text = await res.text();
  const d = res.status === 200 ? data(text) : undefined;
  // back on Xiaomi's sign-in page: the passToken doesn't sign on here
  if (d === undefined) throw new Error(`Xiaomi MiMo platform ${path}: the Xiaomi account didn't sign on (${statusLine(res.status)})`);
  const got = {};
  for (const c of jar.for(PLATFORM + '/')) got[c.name] = c.value;
  return { cookies: got, data: d };
}

// the platform's session per Xiaomi user, and each user's tp- key with when it was read (caches: lost with the engine,
// read again)
const platform = new Map();
const planKeys = new Map();

/** Forgets what the caches know (tests). */
export function resetPlatform() {
  platform.clear();
  planKeys.clear();
}

// reads the platform's pages for an account, keeping the session each answer was read with for the next
const reader = (creds, who, budget) => {
  let c = platform.get(who);
  const started = Date.now();
  return async (path) => {
    const r = await platformPage(creds, path, c, Math.max(500, budget - (Date.now() - started)));
    c = r.cookies;
    platform.set(who, c);
    return r.data;
  };
};

/**
 * The account's Token Plan at the open platform, as { plan, until, renew, window }, or null: none, or the platform can't be
 * read (the app's card goes on without it). Its credits are spent by its tp- key, not by this account's requests, so they
 * are an aside.
 */
export async function tokenPlan(creds, app, budget = 20_000) {
  const who = String(creds.userId);
  try {
    const read = reader(creds, who, budget);
    const p = await read('/tokenPlan/detail');
    const name = typeof p?.planName === 'string' ? p.planName.trim() : '';
    if (!name || p.expired !== false) return null;
    const out = { plan: `Token Plan ${name}`, renew: p.enableAutoRenew || p.hasAutoRenewSubscribed ? 'auto' : 'off' };
    // the platform's times are UTC ("有效期至 2026-11-06 23:59:59 (UTC)")
    const end = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(p.currentPeriodEnd ?? '') ? Date.parse(p.currentPeriodEnd.replace(' ', 'T') + 'Z') : NaN;
    if (!isNaN(end)) out.until = new Date(end).toISOString();
    try {
      const u = await read('/tokenPlan/usage');
      const w = creditWindow(u, app);
      if (w) {
        out.window = w;
        if (out.until) out.window.resetsAt = out.until;
      }
    } catch {}
    return out;
  } catch {
    platform.delete(who);
    return null;
  }
}

/**
 * The account's Token Plan as { key, base, at }: its tp- key and OpenAI base URL, or null when it has no live plan or no key
 * (the platform's page makes one; the plugin doesn't make it for them). Kept for TP_LIFE.
 */
export async function planKey(creds, budget = 20_000) {
  const who = String(creds.userId);
  const had = planKeys.get(who);
  if (had && Date.now() - had.at < TP_LIFE) return had;
  planKeys.delete(who);
  try {
    const read = reader(creds, who, budget);
    const p = await read('/tokenPlan/detail');
    if (!p?.planName || p.expired !== false) return null;
    const k = await read('/tokenPlan/apiKey');
    const base = typeof k?.openaiBaseUrl === 'string' && /^https:\/\/[^/]+\.xiaomimimo\.com\//.test(k.openaiBaseUrl) ? k.openaiBaseUrl.replace(/\/+$/, '') : '';
    if (!base) return null;
    const key = await read('/tokenPlan/apiKey/raw');
    if (typeof key !== 'string' || !key.startsWith('tp-')) return null;
    const got = { key, base, at: Date.now() };
    planKeys.set(who, got);
    return got;
  } catch {
    platform.delete(who);
    return null;
  }
}

/** Drops an account's tp- key, read again next time. */
export const forgetKey = (who) => planKeys.delete(String(who));
/** The key already read for an account, without asking (what `prepare` can afford in its five seconds). */
export const knownKey = (who) => {
  const had = planKeys.get(String(who));
  return had && Date.now() - had.at < TP_LIFE ? had : null;
};

/** The Token Plan's credits spent, as a usage window, or null when the page doesn't say. */
export function creditWindow(page, app) {
  const items = [...(page?.monthUsage?.items ?? []), ...(page?.usage?.items ?? [])];
  const it = items.find((x) => x?.name === 'month_total_token') ?? items.find((x) => x?.name === 'plan_total_token');
  if (!(Number.isFinite(it?.used) && Number(it?.limit) > 0)) return null;
  const w = {
    name: app ? 'Token Plan · API key' : 'Token Plan',
    used: Math.max(0, Math.min(100, (100 * it.used) / it.limit)),
    display: `${credits(it.used)} / ${credits(it.limit)} credits`,
  };
  // with an app plan, the account's requests go to the app: the Token Plan's credits are its key's, an aside
  if (app) w.aside = true;
  return w;
}
