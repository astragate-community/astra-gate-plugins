// Trae: the allowance card — the account's plan and what it has used, from the page the realm bills on.
import { post } from "./api.mjs"
import { Expired, errorOf, lapsedCode, statusLine } from "./errors.mjs"
import { whenOf } from "./values.mjs"

export const round = (n) => Math.round(n * 100) / 100

// credits adds up the account's entitlement packs as the IDE shows them:
// each pack with a credit limit (-1 unlimited) and what it used
export function credits(v) {
  let limit = 0
  let used = 0
  let unlimited = false
  let soonest = 0
  for (const p of v?.user_entitlement_pack_list ?? []) {
    const bi = p?.entitlement_base_info ?? {}
    const l = Number(bi?.quota?.credits_limit)
    if (!Number.isFinite(l)) continue
    const u = Number(p?.usage?.credits_amount) || 0
    if (l === -1) unlimited = true
    else if (l >= 0) limit += l
    if (u > 0) used += u
    const end = whenOf(bi.end_time ?? bi.expire_time ?? p.end_time)
    if (end && (!soonest || end < soonest)) soonest = end
  }
  return { limit, used, unlimited, until: soonest }
}

// dollarUsageOf reads an account's entitlement pack as the dollar billing
// has it (the international deployment): the period's allowance in dollars
// (basic_usage_limit plus bonus_usage_limit) and what was used of each
// (basic_usage_amount, bonus_usage_amount). null when the answer carries no
// pack.
export function dollarUsageOf(v) {
  const pack = (v?.user_entitlement_pack_list ?? []).find((p) => p?.usage || p?.entitlement_base_info?.quota)
  const quota = pack?.entitlement_base_info?.quota
  if (!pack || !quota) return null
  const basic = Number(quota.basic_usage_limit) || 0
  const bonus = Number(quota.bonus_usage_limit) || 0
  const used = Number(pack.usage?.basic_usage_amount) || 0
  const usedBonus = Number(pack.usage?.bonus_usage_amount) || 0
  const end = whenOf(pack.entitlement_base_info.end_time)
  return { plan: String(pack.display_desc ?? ""), basic, bonus, used, usedBonus, end }
}

// the card of each kind of billing page (site.usage.kind), from the page's answer
const cards = {
  // Trae CN: the credits page
  credits(v, a, signIn) {
    const c = credits(v)
    const out = { plan: v.is_credits_billing ? "Credits" : "Free", user: a.name || a.uid, signIn }
    if (c.unlimited) out.balance = "unlimited"
    else if (c.limit > 0) {
      // the count rides on the window (amount of limit, in credits), as
      // WorkBuddy's does, so magpie says it in the window's row, used or
      // left, in its own words and number format, rather than as an
      // English balance line beside it (yetone/magpie#694)
      const w = { name: "Credits", used: Math.max(0, Math.min(100, (c.used / c.limit) * 100)), amount: round(c.used), limit: round(c.limit), unit: "credits" }
      if (c.until) w.resetsAt = new Date(c.until).toISOString()
      out.windows = [w]
    }
    return out
  },
  // Trae Global: the dollar billing's entitlements
  dollar(v, a, signIn) {
    const d = dollarUsageOf(v)
    if (!d) return { error: "Trae Global usage: no entitlement pack in the answer", signIn, user: a.name }
    const total = d.basic + d.bonus
    const used = d.used + d.usedBonus
    const out = { plan: d.plan || "Free", user: a.name || a.uid, signIn }
    if (total > 0) {
      // the allowance rides the window (amount of limit, in dollars), as
      // WorkBuddy's does, so magpie says it in the window's row, used or
      // left, in its own words and number format (yetone/magpie#694)
      const w = { name: "Dollar Usage", used: Math.round(Math.max(0, Math.min(100, (used / total) * 100)) * 100) / 100, amount: round(used), limit: round(total), unit: "usd" }
      if (d.end) w.resetsAt = new Date(d.end).toISOString()
      out.windows = [w]
    }
    return out
  },
}

// usageCard is the card the realm's billing page answered with
export const usageCard = (site, v, a, signIn) => cards[site.usage.kind](v, a, signIn)

// readUsage is the auth.usage hook: the account's card, or the error to show
export async function readUsage(site, sessions, getAuth) {
  let a
  try {
    a = await sessions.fresh(getAuth)
  } catch (e) {
    return { error: e.message, signIn: e instanceof Expired ? "expired" : "kept" }
  }
  const signIn = a.renewed ? "renewed" : "kept"
  let r
  try {
    r = await post(a, site, site.usage.host(site, a) + site.usage.path, site.usage.body)
  } catch (e) {
    return { error: `${site.realm} ${site.usage.label}: ` + (e?.message ?? e), signIn }
  }
  const e = errorOf(r.v)
  if (r.status === 401 || lapsedCode(e.code, site)) return { error: `${a.name || a.uid}: ${site.realm}'s sign-in has expired — sign in again`, signIn: "expired" }
  if (r.status !== 200 || (e.code && String(e.code) !== "0")) return { error: `${site.realm} ${site.usage.label}: ${e.message || statusLine(r.status)}`, signIn, user: a.name }
  return usageCard(site, r.v, a, signIn)
}
