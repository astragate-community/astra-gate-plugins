// Where an account's requests go: its own coding plan, a gift plan beside it, or the Start Plan alone.
import { call } from "./api.mjs"
import { startPlan } from "./gift.mjs"
import { rootOf } from "./sites.mjs"
import { isTeam } from "./util.mjs"

// planOf names the coding plan a key has, "" for none.
export async function planOf(s) {
  const subs = (await call("GET", rootOf(s.base) + "/api/biz/subscription/list", { auth: s.key })) ?? []
  return (Array.isArray(subs) ? subs : []).find((x) => String(x.status).toUpperCase() === "VALID")?.productName ?? ""
}

// plansOf says where an account's requests go and what more it can spend:
// {start, gift}. start is true for an account with no coding plan: it
// sends every request to the gift and reads no balance to do it; a team's
// seat, a sign-in with no ZCode token and a key whose plan-list read found
// no gift stay on the coding plan. gift is what a coding account also holds:
// the gift plans ({models}), and its requests spend the gift for a model it
// serves, until it says it is spent (see blocked). Asked again after 10
// minutes (a minute when unsure — a plan-list read that failed is retried
// sooner; a gift read that failed simply leaves gift null until the next
// ask).
export const routes = new Map()
export async function plansOf(s) {
  if (isTeam(s) || !s.jwt) return { start: false, gift: null }
  if (!s.key) return { start: true, gift: null }
  const id = s.key + "\0" + s.jwt
  const r = routes.get(id)
  if (r && Date.now() - r.at < r.ttl) return r
  let start = false
  let gift = null
  let sure = false
  try {
    if (!(await planOf(s))) start = true
    else gift = await startPlan(s.jwt, s.device).catch(() => null)
    sure = true
  } catch {
    // the plan list could not be read: a key account takes the dual route
    // (start stays false, the gift is kept, a minute's ttl), so a gift
    // refusal still replays to the coding plan rather than blacking out
    try {
      gift = await startPlan(s.jwt, s.device)
      sure = false
    } catch {}
  }
  const out = { start, gift, at: Date.now(), ttl: Math.min(sure ? 600_000 : 60_000, gift?.ttl ?? 600_000) }
  routes.set(id, out)
  return out
}
