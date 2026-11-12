// Trae: the allowance card — the account's plan and what it has used, from the page the realm bills on.
import { post } from './api.js';
import { Expired, errorOf, lapsedCode } from './errors.js';
import { statusLine, whenOf } from './values.js';

export const round = (n) => Math.round(n * 100) / 100;

// credits adds up the account's entitlement packs as the IDE shows them: each pack with a credit limit (-1 unlimited)
// and what it used
export function credits(v) {
  let limit = 0, used = 0, unlimited = false, soonest = 0;
  for (const p of v?.user_entitlement_pack_list ?? []) {
    const bi = p?.entitlement_base_info ?? {};
    const l = Number(bi?.quota?.credits_limit);
    if (!Number.isFinite(l)) continue;
    const u = Number(p?.usage?.credits_amount) || 0;
    if (l === -1) unlimited = true;
    else if (l >= 0) limit += l;
    if (u > 0) used += u;
    const end = whenOf(bi.end_time ?? bi.expire_time ?? p.end_time);
    if (end && (!soonest || end < soonest)) soonest = end;
  }
  return { limit, used, unlimited, until: soonest };
}

// dollarUsageOf reads an account's entitlement pack as the dollar billing has it (the international deployment): the
// period's allowance in dollars (basic_usage_limit plus bonus_usage_limit) and what was used of each. null when the
// answer carries no pack.
export function dollarUsageOf(v) {
  const pack = (v?.user_entitlement_pack_list ?? []).find((p) => p?.usage || p?.entitlement_base_info?.quota);
  const quota = pack?.entitlement_base_info?.quota;
  if (!pack || !quota) return null;
  return {
    plan: String(pack.display_desc ?? ''),
    basic: Number(quota.basic_usage_limit) || 0,
    bonus: Number(quota.bonus_usage_limit) || 0,
    used: Number(pack.usage?.basic_usage_amount) || 0,
    usedBonus: Number(pack.usage?.bonus_usage_amount) || 0,
    end: whenOf(pack.entitlement_base_info.end_time),
  };
}

const cards = {
  // Trae CN: the credits page
  credits(v, a) {
    const c = credits(v);
    const out = { plan: v.is_credits_billing ? 'Credits' : 'Free', user: a.name || a.uid };
    if (c.unlimited) out.balance = 'unlimited';
    else if (c.limit > 0) {
      const w = { name: 'Credits', used: Math.max(0, Math.min(100, (c.used / c.limit) * 100)), amount: round(c.used), limit: round(c.limit), unit: 'credits' };
      if (c.until) w.resetsAt = new Date(c.until).toISOString();
      out.windows = [w];
    }
    return out;
  },
  // Trae Global: the dollar billing's entitlements
  dollar(v, a) {
    const d = dollarUsageOf(v);
    if (!d) return { error: 'Trae Global usage: no entitlement pack in the answer', user: a.name };
    const total = d.basic + d.bonus;
    const used = d.used + d.usedBonus;
    const out = { plan: d.plan || 'Free', user: a.name || a.uid };
    if (total > 0) {
      const w = { name: 'Dollar Usage', used: Math.round(Math.max(0, Math.min(100, (used / total) * 100)) * 100) / 100, amount: round(used), limit: round(total), unit: 'usd' };
      if (d.end) w.resetsAt = new Date(d.end).toISOString();
      out.windows = [w];
    }
    return out;
  },
};

export const usageCard = (site, v, a) => cards[site.usage.kind](v, a);

// readUsage is the account's card, or the error to show; `expired` is told when the token was turned away
export async function readUsage(site, fresh, onExpired) {
  let a;
  try {
    a = await fresh();
  } catch (e) {
    if (e instanceof Expired) await onExpired?.();
    return { error: e.message, signIn: e instanceof Expired ? 'expired' : 'kept' };
  }
  const signIn = a.renewed ? 'renewed' : 'kept';
  let r;
  try {
    r = await post(a, site, site.usage.host(site, a) + site.usage.path, site.usage.body);
  } catch (e) {
    return { error: `${site.realm} ${site.usage.label}: ` + (e?.message ?? e), signIn };
  }
  const e = errorOf(r.v);
  if (r.status === 401 || lapsedCode(e.code, site)) {
    await onExpired?.();
    return { error: `${a.name || a.uid}: ${site.realm}'s sign-in has expired — sign in again`, signIn: 'expired' };
  }
  if (r.status !== 200 || (e.code && String(e.code) !== '0')) return { error: `${site.realm} ${site.usage.label}: ${e.message || statusLine(r.status)}`, signIn, user: a.name };
  return { ...usageCard(site, r.v, a), signIn };
}
