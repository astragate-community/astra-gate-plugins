// Xiaomi MiMo: the account's allowance card, from the pages the app's "Usage & billing" reads: /user/usage, how much of the
// week's allowance is left (percent remaining, and the day it resets; no reset date is no plan), and
// /user/xiaomi/subscription/self, the plan in force and when it ends. An account with no plan is on MiMo's free offer.
import { http } from 'astra';
import { SLOW_BUDGET, appHeaders } from './constants.js';
import { cookieHeader } from './cookies.js';
import { tokenPlan } from './platform.js';
import { fresh } from './session.js';
import { Lapsed, statusLine, tryJSON, vendorError } from './util.js';

// the app's names for its plans' tiers
export const TIERS = { 1: 'Starter', 2: 'Plus', 3: 'Pro', 4: 'Ultra' };

/** One of the server's times: "2026-10-01T00:00:00", or a day alone. They carry no zone, and the app shows them as they come, which is Beijing's (and Singapore's) time. */
export function serverTime(v) {
  const s = String(v ?? '').trim();
  let iso = '';
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i.test(s)) iso = s;
  else if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?$/.test(s)) iso = s.replace(' ', 'T') + '+08:00';
  else if (/^\d{4}-\d\d-\d\d$/.test(s)) iso = s + 'T00:00:00+08:00';
  const t = iso ? Date.parse(iso) : NaN;
  return isNaN(t) ? undefined : new Date(t).toISOString();
}

// whether a parsed page body is the server's envelope; anything else is a redirect to Xiaomi's sign-in
const isEnvelope = (env) => !!env && typeof env === 'object' && !Array.isArray(env) && !(env.code != null && !Number.isInteger(env.code)) && !(env.msg != null && typeof env.msg !== 'string');

/** The app's plan in force (`current`, from the subscription page) as the card shows it. */
export function planOf(c) {
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const out = { plan: text(c.title) || TIERS[c.planTier] || text(c.planCode) || 'MiMo' };
  const until = serverTime(c.endTime);
  if (until) out.until = until;
  if (c.renewalMode === 'MONTHLY' || c.renewalMode === 'YEARLY') out.renew = 'auto';
  else if (c.renewalMode === 'ONE_TIME') out.renew = 'off';
  return out;
}

/** The week's allowance as a usage window, or null (no plan: the free offer shows no allowance). */
export function weekOf(use) {
  const percent = use?.percent;
  const reset = use?.resetDate;
  if (!(typeof percent === 'number' && typeof reset === 'string')) return null;
  const w = { name: '7 days', used: Math.max(0, Math.min(100, 100 - percent)), span: 7 * 24 * 3600 };
  const at = serverTime(reset);
  if (at) w.resetsAt = at;
  return w;
}

class Gone extends Error {}

// asks the MiMo server for one of the account's pages, signing on again once when it is turned away, and gives its data
async function page(account, path) {
  for (let t = 0; ; t++) {
    let s;
    try {
      s = await fresh(account, { force: t > 0, budget: SLOW_BUDGET });
    } catch (e) {
      if (e instanceof Lapsed) throw new Gone(e.message);
      throw e;
    }
    const res = await http.fetch(s.creds.base.replace(/\/+$/, '') + path, { headers: { cookie: cookieHeader(s.cookies), ...appHeaders() }, redirect: 'manual', timeoutMs: 20_000 });
    const text = await res.text();
    const env = tryJSON(text);
    const bad = !isEnvelope(env);
    if (res.status === 401 || (res.status >= 300 && res.status < 400) || (res.status === 200 && bad)) {
      // a session gone stale, or a redirect to Xiaomi's sign-in
      if (t === 0) continue;
      throw new Gone(`${s.creds.userId}: the Xiaomi MiMo sign-in has expired — sign in again`);
    }
    if (res.status !== 200 || bad) throw new Error(`Xiaomi MiMo ${path}: ${vendorError(text, statusLine(res.status))}`);
    if ((env.code ?? 0) !== 0) throw new Error(`Xiaomi MiMo ${path}: code ${env.code} ${env.msg ?? ''}`);
    return { data: env.data, s };
  }
}

/** The plan and the week's allowance (and the Token Plan's credits beside them), as the usage card. */
export async function usageOf(account) {
  let self;
  try {
    self = await page(account, '/user/xiaomi/subscription/self');
  } catch (e) {
    return { error: e?.message ?? String(e), ...(e instanceof Gone ? { signIn: 'expired' } : {}) };
  }
  const c = self.data?.current;
  const app = !!c && typeof c === 'object';
  const tp = await tokenPlan(self.s.creds, app);
  let out = { plan: 'Free' };
  if (app) out = planOf(c);
  else if (tp) {
    // no app plan: the account's plan is the platform's Token Plan
    out.plan = tp.plan;
    if (tp.until) out.until = tp.until;
    out.renew = tp.renew;
  }
  let use;
  try {
    use = (await page(account, '/user/usage')).data;
  } catch (e) {
    if (e instanceof Gone) out.error = e.message;
    // the plan alone, when the week's allowance can't be read
    return { ...out, ...(tp?.window && { windows: [tp.window] }) };
  }
  const windows = [];
  const week = weekOf(use);
  if (week) windows.push(week);
  if (tp?.window) windows.push(tp.window);
  if (windows.length) out.windows = windows;
  return out;
}
