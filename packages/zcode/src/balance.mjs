// The Start Plan's balance as allowance-card windows (the card of a gift-only account, and the gift half of a dual one).
import { balanceOf, bucketModels, giftSpent, samePlan } from "./gift.mjs"
import { compact, periodOf } from "./windows.mjs"
import { first, startNum } from "./util.mjs"

const str = (v) => (typeof v === "string" ? v : "")
const isStatus = (p, status) => p.status.trim().toLowerCase() === status

// giftOf reads the balance and returns the gift's card fields: its plans and
// windows. Several plans can be active at once, so every live plan's buckets
// show, each keeping its own models and end; the plan and end put on the
// card (for a gift-only account) are the soonest-ending live plan's. null
// when there is no live plan to show.
export async function giftOf(s) {
  const b = await balanceOf(s.jwt, s.device)
  const plans = (Array.isArray(b.plans) ? b.plans : []).map((p) => ({ ...p, status: str(p?.status), user_plan_id: str(p?.user_plan_id), plan_id: str(p?.plan_id) }))
  const now = startNum(b.server_time) > 0 ? startNum(b.server_time) : Math.trunc(Date.now() / 1000)
  const over = new Set()
  for (const p of plans) {
    const end = startNum(p.ends_at)
    if (end > 0 && end <= now && isStatus(p, "active")) p.status = "expired"
    if (isStatus(p, "expired")) over.add(p.user_plan_id + "\0" + p.plan_id)
  }
  const balances = (Array.isArray(b.balances) ? b.balances : [])
    .map((x) => ({ ...x, user_plan_id: str(x?.user_plan_id), plan_id: str(x?.plan_id) }))
    .filter((x) => {
      let keep = true
      for (const p of plans) {
        if (!samePlan(x, p)) continue
        keep = !over.has(p.user_plan_id + "\0" + p.plan_id)
        if (keep) break
      }
      return keep
    })

  // every live plan counts as the gift: no plan-name filter decides it,
  // the balance says what the session can spend
  const live = plans.filter((p) => {
    if (!isStatus(p, "active")) return false
    const end = startNum(p.ends_at)
    return !(end > 0 && end <= now)
  })
  let active = null
  for (const p of live) {
    const end = startNum(p.ends_at)
    if (active && !(end > 0 && (!startNum(active.end) || end < startNum(active.end)))) continue
    active = { name: first(str(p.name), "Start Plan"), end, until: end > 0 ? new Date(Math.trunc(end) * 1000).toISOString() : "" }
  }
  if (!active) return null
  const out = { plan: active.name, windows: [] }
  if (active.until) Object.assign(out, { until: active.until, renew: "off" })
  for (const x of balances) {
    const owner = live.find((p) => samePlan(x, p))
    if (!owner) continue
    const exp = startNum(x.expires_at)
    if (exp > 0 && exp <= now) continue // a bucket past its own end is over
    const total = startNum(x.total_units), left = startNum(x.remaining_units)
    let used = startNum(x.used_units)
    if (total === undefined && used === undefined && left === undefined) continue
    const models = bucketModels(x)
    const base = first(str(x.show_name), models.join(", "), "Credits")
    const w = { name: base, used: 0, _plan: str(owner.name), _spent: giftSpent(x) }
    if (used === undefined) used = total !== undefined && left !== undefined ? total - left : 0
    if (total > 0) {
      // the bucket's count as amount of limit, as the Coding windows' is
      // (#659): magpie says it as used or as left, as it says the share
      w.used = (100 * used) / total
      w.amount = used
      w.limit = total
      w.display = `${compact(used)} / ${compact(total)}`
    }
    if (w._spent) w.used = Math.max(100, w.used)
    if (exp > 0) w.resetsAt = new Date(Math.trunc(exp) * 1000).toISOString()
    let span = 0
    for (const p of plans) {
      if (!samePlan(x, p)) continue
      for (const e of Array.isArray(p.entitlements) ? p.entitlements : []) {
        if (str(e?.entitlement_id) === str(x.entitlement_id)) span = periodOf(str(e?.period))
      }
    }
    if (!span) {
      const a = startNum(x.period_start), z = startNum(x.period_end)
      if (a !== undefined && z !== undefined && z > a) span = Math.trunc(z - a)
    }
    if (span) w.span = span
    if (models.length) w.models = models
    out.windows.push(w)
  }
  return out
}
