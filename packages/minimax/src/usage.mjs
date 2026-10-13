// MiniMax Code: the allowance card — the account's plan, credits and the M Plan's windows.
import { AccountRefused, identity, membershipReply, planRemains, workspaces } from "./api.mjs"
import { num, obj, str } from "./values.mjs"

// membershipOf reads a membership answer (or a workspace) as mcode does.
export function membershipOf(e) {
  const d = obj(e?.data)
  const pick = (k) => e?.[k] ?? d?.[k]
  const s = (k) => (typeof pick(k) === "string" && pick(k).trim() ? pick(k).trim() : undefined)
  const has = typeof pick("has_token_plan") === "boolean" ? pick("has_token_plan") : undefined
  const ends = num(pick("token_plan_expires_at"))
  const sum = obj(e?.op_credit_summary) ?? obj(d?.op_credit_summary)
  const bal = str(sum, "total_remaining_amount") ?? (() => {
    const v = pick("opcredit_balance")
    return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined
  })()
  return {
    ...(has !== undefined ? { hasTokenPlan: has } : {}),
    ...(s("op_group_id") ? { opGroupId: s("op_group_id") } : {}),
    ...(s("token_plan_tier") ? { tier: s("token_plan_tier") } : {}),
    ...(ends > 0 ? { expiresAt: ends } : {}),
    ...(bal !== undefined ? { balance: bal } : {}),
  }
}

// membership is the account's plan and credits: its own workspace's
// (workspace_type 0), with what the membership API says of that workspace.
export async function membership(site, access, userID) {
  let ws
  try {
    for (const w of await workspaces(site, access, userID)) {
      if (num(w?.workspace_type) !== 0) continue
      const id = typeof w.workspace_id === "number" && w.workspace_id >= 0 ? w.workspace_id : str(w, "workspace_id")
      if (id !== undefined) {
        ws = { id, m: membershipOf(w) }
        break
      }
    }
  } catch (e) {
    if (e instanceof AccountRefused) throw e
    return membershipOf(await membershipReply(site, access, userID))
  }
  if (!ws) return {}
  try {
    const m = membershipOf(await membershipReply(site, access, userID, { workspace_id: ws.id }))
    const has = ws.m.hasTokenPlan === true || m.hasTokenPlan === true ? true : ws.m.hasTokenPlan === false || m.hasTokenPlan === false ? false : undefined
    return { ...ws.m, ...m, ...(has !== undefined ? { hasTokenPlan: has } : {}), ...(ws.m.opGroupId || m.opGroupId ? { opGroupId: ws.m.opGroupId ?? m.opGroupId } : {}) }
  } catch (e) {
    if (e instanceof AccountRefused) throw e
    return ws.m
  }
}

// planWindows reads the M Plan's windows from coding_plan/remains, as
// magpie's own MiniMax plan reader (readMiniMaxPlan) does: each model
// group's interval and week, "general" the plan's own, the rest aside.
export function planWindows(body) {
  const br = obj(body?.base_resp)
  if (br && typeof br.status_code === "number" && br.status_code !== 0) throw new Error(str(br, "status_msg") ?? `MiniMax said ${br.status_code}`)
  if (!br && !Array.isArray(body?.model_remains)) throw new Error("no plan in the reply")
  const ms = (n) => (n < 1e12 ? n * 1000 : n)
  const zero = (v) => num(v) === 0
  const out = []
  for (const k of Array.isArray(body.model_remains) ? body.model_remains : []) {
    const name = String(k?.model_name ?? "").trim()
    if (!name || (num(k.current_interval_status) === 3 && num(k.current_weekly_status) === 3 && zero(k.current_interval_total_count) && zero(k.current_weekly_total_count))) continue
    const general = name.toLowerCase() === "general"
    for (const x of [
      { left: num(k.current_interval_remaining_percent), status: num(k.current_interval_status) ?? 0, start: num(k.start_time) ?? 0, end: num(k.end_time) ?? 0, week: false },
      { left: num(k.current_weekly_remaining_percent), status: num(k.current_weekly_status) ?? 0, start: num(k.weekly_start_time) ?? 0, end: num(k.weekly_end_time) ?? 0, week: true },
    ]) {
      if (x.status === 3 || (x.left === undefined && x.status !== 2)) continue
      const w = { used: x.status === 2 ? 100 : Math.max(0, Math.min(100, 100 - x.left)) }
      let span = 0
      if (x.start > 0 && x.end > x.start) span = ms(x.end) - ms(x.start)
      else if (x.week) span = 7 * 86400_000
      if (span) w.span = span / 1000
      if (x.end > 0) w.resetsAt = new Date(ms(x.end)).toISOString()
      w.name = x.week ? "7 days"
        : span > 86400_000 && span % 86400_000 === 0 ? `${span / 86400_000} days`
        : span >= 3600_000 && span % 3600_000 === 0 ? `${span / 3600_000} hours`
        : span > 0 ? `${Math.floor(span / 60_000)} minutes`
        : "Allowance"
      if (!general) {
        w.name = name[0].toUpperCase() + name.slice(1) + " · " + w.name
        w.aside = true
      }
      out.push(w)
    }
  }
  return out
}

async function planQuota(site, access, group) {
  return planWindows(await planRemains(site, access, group))
}

// credits says a balance as a count of credits: "1234.50" is "1234.5 credits".
export function credits(b) {
  const n = Number(b)
  if (!Number.isFinite(n)) return String(b)
  return (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")) + " credits"
}

// usageOf is the card: the plan (the M Plan's tier, else Free), the credits
// left, and the M Plan's windows when there are any.
export function usageOf(m, windows = []) {
  const plan = m.hasTokenPlan ? (m.tier ? "M Plan " + m.tier : "M Plan") : "Free"
  return {
    plan,
    ...(m.hasTokenPlan && m.expiresAt ? { until: new Date(m.expiresAt < 1e12 ? m.expiresAt * 1000 : m.expiresAt).toISOString() } : {}),
    ...(m.balance !== undefined ? { balance: credits(m.balance) } : {}),
    windows,
  }
}

/** auth.usage: the account's credits and M Plan; nothing is claimed here. */
export const usageHookOf = (site, fresh) => async (getAuth) => {
  const auth = await getAuth()
  if (auth?.type !== "oauth" || !auth.access) return { error: "not signed in" }
  let a, did
  try {
    ;({ a, renewed: did } = await fresh(getAuth))
  } catch (e) {
    return { error: e?.message ?? String(e), ...(e?.signIn ? { signIn: e.signIn } : {}) }
  }
  try {
    const who = a.realUserID ? { realUserID: a.realUserID, email: a.email, name: a.name } : await identity(site, a.access)
    const m = await membership(site, a.access, who.realUserID)
    let windows = []
    let error
    if (m.hasTokenPlan && m.opGroupId) {
      try {
        windows = await planQuota(site, a.access, m.opGroupId)
      } catch (e) {
        error = e?.message ?? String(e)
      }
    }
    return {
      ...usageOf(m, windows),
      ...(error ? { error } : {}),
      user: who.email || who.name || who.realUserID,
      signIn: did ? "renewed" : "kept",
    }
  } catch (e) {
    return { error: e?.message ?? String(e), signIn: "kept" }
  }
}
