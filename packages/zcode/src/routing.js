// Where an account's requests go: its own coding plan, a gift plan beside it, or the Start Plan alone.
import { storage } from 'astra';
import { call } from './api.js';
import { startPlan } from './gift.js';
import { rootOf } from './sites.js';
import { isTeam } from './util.js';

// planOf names the coding plan a key has, "" for none.
export async function planOf(s) {
  const subs = (await call('GET', rootOf(s.base) + '/api/biz/subscription/list', { auth: s.key })) ?? [];
  return (Array.isArray(subs) ? subs : []).find((x) => String(x.status).toUpperCase() === 'VALID')?.productName ?? '';
}

export const routeKey = (accountKey) => `route:${accountKey}`;

// plansOf says where an account's requests go and what more it can spend: {start, gift}. start is true for an account
// with no coding plan: it sends every request to the gift and reads no balance to do it; a team's seat, a sign-in with
// no ZCode token and a key whose plan-list read found no gift stay on the coding plan. gift is what a coding account
// also holds: the gift plans ({models}), spent only by asking a "-Trial" model. Asked again after 10 minutes (a minute
// when unsure). The answer is kept in storage per account (the host may restart the sandbox between requests).
export async function plansOf(s, accountKey) {
  if (isTeam(s) || !s.jwt) return { start: false, gift: null };
  if (!s.key) return { start: true, gift: null };
  const id = routeKey(accountKey);
  const r = await storage.get(id);
  if (r && Date.now() - r.at < r.ttl) return r;
  let start = false;
  let gift = null;
  let sure = false;
  try {
    if (!(await planOf(s))) start = true;
    else gift = await startPlan(s.jwt, s.device).catch(() => null);
    sure = true;
  } catch {
    // the plan list could not be read: a key account takes the dual route (start stays false, the gift is kept, a minute's ttl)
    try {
      gift = await startPlan(s.jwt, s.device);
      sure = false;
    } catch {}
  }
  const out = { start, gift, at: Date.now(), ttl: Math.min(sure ? 600_000 : 60_000, gift?.ttl ?? 600_000) };
  await storage.set(id, out);
  return out;
}
