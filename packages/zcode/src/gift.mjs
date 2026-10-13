// ZCode's Start Plan and the "gift" plans beside a coding plan: their buckets, which models they serve, and
// when one says it is spent.
import { APP_VERSION, EXPIRED, MODELS, ZCODE } from "./constants.mjs"
import { call } from "./api.mjs"
import { jwtExpired } from "./session.mjs"
import { num } from "./util.mjs"

// the alias is the catalog spelling of the model plus -trial, so the picker
// reads GLM-5.3-Trial while the loader strips it back to the raw name
export const giftID = (m) => (MODELS.find((x) => x.id.toLowerCase() === String(m).toLowerCase())?.id ?? m) + "-Trial"
export const uniqueModels = (names) => {
  const byName = new Map()
  for (const m of names) if (!byName.has(m.toLowerCase())) byName.set(m.toLowerCase(), m)
  return [...byName.values()]
}
export const giftNames = (g) => g?.allModels ?? g?.models ?? []
export const giftModel = (g, id) => giftNames(g).find((m) => giftID(m).toLowerCase() === id.toLowerCase())
export const bucketModels = (x) => (Array.isArray(x.capabilities) ? x.capabilities : [])
  .map((c) => String(c ?? "").trim()).filter((c) => c.startsWith("model:") || !c.includes(":"))
  .map((c) => c.replace(/^model:/, "").trim()).filter(Boolean)

// Both the card and the request route use the same test for a spent bucket.
// Older balances may omit remaining_units but still tell used and total.
export const giftSpent = (x) => {
  const left = num(x.remaining_units)
  if (left !== undefined) return left <= 0
  const total = num(x.total_units), used = num(x.used_units)
  return total !== undefined && used !== undefined && used >= total
}

// samePlan: a balance bucket belongs to a plan by its user plan's id, else by the plan's own.
export const samePlan = (x, p) => (x.user_plan_id && p.user_plan_id ? x.user_plan_id === p.user_plan_id : String(x.plan_id ?? "") === String(p.plan_id ?? ""))

// balanceOf reads the Start Plan's balance with ZCode's session token.
export async function balanceOf(jwt, device) {
  if (!jwt) throw new Error("not signed in to ZCode")
  if (jwtExpired(jwt)) throw new Error(EXPIRED)
  return (await call("GET", `${ZCODE}/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}`, { auth: "Bearer " + jwt, device })) ?? {}
}

// startPlan is the gift an account can spend now ({models}), as ZCode reads
// its balance: several plans can be active at once, and a model routes to
// the gift when any of them has a live bucket serving it — a bucket past
// its plan's own end, or one whose remaining_units says none, is skipped
// rather than asked and refused. models are those live buckets' names.
export async function startPlan(jwt, device) {
  const b = await balanceOf(jwt, device)
  const now = num(b.server_time) > 0 ? num(b.server_time) : Date.now() / 1000
  const plans = Array.isArray(b.plans) ? b.plans : []
  const balances = Array.isArray(b.balances) ? b.balances : []
  const ms = new Set(), all = new Map()
  let ttl = 600_000
  let any = false
  let name = ""
  for (const p of plans) {
    const st = String(p?.status ?? "").trim().toLowerCase()
    const end = num(p?.ends_at)
    if (st !== "active" || (end > 0 && end <= now)) continue
    any = true
    if (end > 0) ttl = Math.min(ttl, (end - now) * 1000)
    if (!name) name = String(p?.name ?? "").trim()
    for (const x of balances) {
      if (!samePlan(x, p)) continue
      const exp = num(x.expires_at)
      if (exp > 0 && exp <= now) continue
      if (exp > 0) ttl = Math.min(ttl, (exp - now) * 1000)
      // Spent buckets still declare models; only live ones can spend now.
      for (const m of bucketModels(x)) {
        if (!all.has(m.toLowerCase())) all.set(m.toLowerCase(), m)
        if (!giftSpent(x)) ms.add(m)
      }
    }
  }
  return any ? { name: name || "Start Plan", models: [...ms], allModels: [...all.values()], ttl } : null
}

// blocked remembers the models a gift said it has none left for: a key+jwt+
// model for a minute, so one turn that is refused does not ask again.
export const blocked = new Map()

// giftServes: the gift's buckets name their models lowercased ("glm-5.3-
// flash"); what is asked for arrives as the plan lists it ("GLM-5.3-Flash").
export const giftServes = (gift, m) => (gift.models ?? []).some((x) => x.toLowerCase() === m.toLowerCase())
export const giftUsable = (s, gift, m) => !jwtExpired(s.jwt) && giftServes(gift, m) &&
  Date.now() >= (blocked.get(s.key + "\0" + s.jwt + "\0" + m.toLowerCase()) ?? 0)

// spentUp is the gift saying it has nothing left to spend: its own no-
// resource-package code 1113, its "exceed quota limit" 1005 — a spent gift
// can answer a 200 with a JSON body carrying one of those codes. Every 429
// counts as spent, Z.ai's 1302/1303 rate limits among them.
export function spentUp(text, status) {
  if (status === 429) return true
  let b
  try { b = JSON.parse(text) } catch { return false }
  if (!b || typeof b !== "object") return false
  const code = (v) => String(v ?? "")
  const c1 = code(b.code), c2 = code(b.error?.code)
  return c1 === "1113" || c1 === "1005" || c2 === "1113" || c2 === "1005"
}
