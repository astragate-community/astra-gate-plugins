// The plan's allowance, as magpie's built-in showed it (internal/provider zcode.go, zcode_start.go,
// zcode_team.go): the Coding Plan's windows and term, the Start Plan's buckets, or a team seat's
// windows and its plan's end.
import { APP_VERSION, PROVIDER, ZCODE } from "./constants.mjs"
import { call } from "./api.mjs"
import { giftOf } from "./balance.mjs"
import { giftID, uniqueModels } from "./gift.mjs"
import { jwtExpired, keyOf, stateOf } from "./session.mjs"
import { plansOf, routes } from "./routing.mjs"
import { teamHeaders } from "./keys.mjs"
import { bizRoot, rootOf } from "./sites.mjs"
import { first, isTeam, platform } from "./util.mjs"
import { limitWindows, termOf, when } from "./windows.mjs"

// codingUsage is a Coding Plan key's allowance: credits per five hours and
// per week, the plan's level and its term.
export async function codingUsage(s) {
  const root = rootOf(s.base)
  const d = (await call("GET", root + "/api/monitor/usage/quota/limit", { auth: s.key })) ?? {}
  const out = {}
  const level = typeof d.level === "string" ? d.level : ""
  if (level) out.plan = "GLM Coding " + level[0].toUpperCase() + level.slice(1)
  out.windows = limitWindows(d)
  try {
    Object.assign(out, termOf(await call("GET", root + "/api/biz/subscription/list", { auth: s.key })))
  } catch {}
  return out
}

// teamResets is how many resets a team member may spend, of the five hours
// and of the week: those of customer-package-reset/list still available.
// null when it can't be told or there are none.
async function teamResets(root, auth, headers) {
  let d
  try {
    d = (await call("GET", root + "/api/biz/customer-package-reset/list?targetType=TEAM", { auth, headers })) ?? {}
  } catch {
    return null
  }
  let until = 0
  const count = (rs) => {
    let n = 0
    for (const x of Array.isArray(rs) ? rs : []) {
      if (x?.available !== true) continue
      n++
      const t = when(x.expireTime)
      if (t && (!until || t < until)) until = t
    }
    return n
  }
  const fiveHour = count(d.fiveHourResets)
  const weekly = count(d.weekResets)
  if (fiveHour + weekly === 0) return null
  const r = { count: fiveHour + weekly, byWindow: true, fiveHour, weekly }
  if (until) r.until = new Date(until).toISOString()
  return r
}

// teamUsage is a team seat's allowance: the team plan's five hours and
// week, and the plan's name and end.
export async function teamUsage(s, key) {
  const root = bizRoot(s.base)
  const headers = teamHeaders(s.base, s.org, s.project)
  const d = (await call("GET", root + "/api/monitor/usage/quota/limit?type=2", { auth: key, headers })) ?? {}
  const out = { windows: limitWindows(d) }
  if (!s.token) return out
  const resets = teamResets(root, s.token, headers)
  try {
    const t = (await call("GET", root + "/api/biz/team/subscribe/product/querySubscribeDetail", { auth: s.token, headers })) ?? {}
    const usable = (t.hasSubscription == null || t.hasSubscription === true) && String(t.status ?? "").toUpperCase() === "EFFECTIVE" &&
      String(t.memberGrantStatus ?? "").toUpperCase() === "VALID"
    if (usable) {
      if (typeof t.productName === "string" && t.productName) out.plan = t.productName
      const end = when(t.subscribeEndTime)
      if (end) Object.assign(out, { until: new Date(end).toISOString(), renew: "off" })
    }
  } catch {}
  const r = await resets
  if (r) out.resets = r
  return out
}

// bestBuckets is, for each model the gift's buckets serve, the index of
// the one a request spends: a live one before a spent one, the least
// used of those. The server picks among an account's buckets itself
// (ZCode sends no plan with a request), so one spent bucket doesn't stop
// a model another still has.
export function bestBuckets(windows) {
  const best = new Map()
  windows.forEach((w, i) => {
    for (const m of w.models ?? []) {
      const key = m.toLowerCase(), old = best.get(key), prev = windows[old]
      if (old === undefined || (prev._spent && !w._spent) || (prev._spent === w._spent && w.used < prev.used)) best.set(key, i)
    }
  })
  return best
}

// startUsage is a gift-only account's card: its buckets, or the words
// for having none to show. The card's header already names the plan, so
// the windows keep their own names.
const NO_START = "this account has no GLM Coding Plan, and ZCode's Start Plan has ended or was never started"
export async function startUsage(s) {
  const g = await giftOf(s)
  if (!g) return { error: NO_START }
  const best = bestBuckets(g.windows)
  g.windows = g.windows.map(({ _plan, _spent, ...w }, i) => {
    if (!w.models?.length) return w
    // a model two plans give (Trust Build's and the Start Plan's Flash)
    // counts on the bucket ZCode spends now; the other stays on the card
    // without holding the model up (ganlerk, Discord)
    const models = w.models.filter((m) => best.get(m.toLowerCase()) === i)
    if (!models.length) {
      delete w.models
      return { ...w, aside: true }
    }
    return { ...w, models: [...models, ...models.map(giftID)] }
  })
  return g
}

// dualUsage shows both pools but only the pool a request can use counts
// for its model. Live gift models don't spend the Coding windows; spent
// or blocked gift buckets stay visible without holding up the Coding Plan.
// Fresh usage also updates the request cache, so a replenished or spent
// gift takes effect before its ten-minute route cache expires. A failed
// gift read leaves the working Coding Plan's card and route alone.
export async function dualUsage(s) {
  const out = await codingUsage(s)
  const cached = routes.get(s.key + "\0" + s.jwt)
  try {
    const g = await giftOf(s)
    const gift = g ? { name: g.plan, models: [...new Set(g.windows.filter((w) => !w._spent)
      .flatMap((w) => w.models ?? []).map((m) => m.toLowerCase()))],
      allModels: uniqueModels(g.windows.flatMap((w) => w.models ?? [])) } : null
    if (cached) {
      cached.gift = gift
      const ends = g ? [g.until, ...g.windows.map((w) => w.resetsAt)].map((t) => Date.parse(t)).filter(Number.isFinite) : []
      if (ends.length) cached.ttl = Math.min(cached.ttl, Math.max(0, Math.min(...ends) - cached.at))
    }
    if (g) {
      // the gift's models are its trial entries alone: a plain model stays
      // on the coding plan, and the user picks the gift by its entry
      const notModels = gift.allModels.map((m) => giftID(m).toLowerCase())
      if (notModels.length) out.windows = out.windows.map((w) => w.aside ? w : { ...w, notModels })
      // Several buckets may serve one model: one spent sibling cannot block it.
      const best = bestBuckets(g.windows)
      out.windows.push(...g.windows.map(({ _plan: p, _spent, ...w }, i) => {
        const selected = gift.allModels.filter((m) => best.get(m.toLowerCase()) === i)
        const models = selected.map(giftID)
        const scoped = models.length ? { ...w, models } : { ...w, aside: true }
        // the card names a bucket's model as the picker does (GLM-5.3-Flash-Trial);
        // no plan prefix — the card's section header already says the account
        let name = w.name
        for (const m of selected) {
          const at = name.toLowerCase().indexOf(m.toLowerCase())
          if (at >= 0) name = name.slice(0, at) + giftID(m) + name.slice(at + m.length)
        }
        return { ...scoped, name }
      }))
    }
  } catch {
    if (cached) {
      cached.gift = null
      cached.at = Date.now()
      cached.ttl = 60_000 // an uncertain gift is read again sooner
    }
  }
  return out
}

// CLAIM_HINT is the claim line's name: a fixed sentence, so magpie
// translates it with the interface's own language (the plan's name and
// the count are data, and go in the display, which is shown as it came).
const CLAIM_HINT = "Gift plans to claim in the ZCode app"

// claimHint is the card's line for gift plans ZCode is holding for the
// account but has not put on it: GET /billing/preview lists them, and
// only the ZCode app claims one — its claim takes the Aliyun captcha
// attestation the app's own renderer makes, so the plugin reads the list
// and asks the user to claim it there. A window, set aside (it is no
// allowance: using it up stops nothing), so the card shows it and
// routing, caps and the menu bar pass it over. The window's name is a
// fixed sentence, so magpie can translate it (a display is shown as it
// came); the count and the plan's own name go in the display. null when
// there is nothing to claim, the preview failing or listing none among
// it: a failed read is no line at all, never a card or a refusal of its
// own.
export async function claimHint(s) {
  if (!s.jwt || jwtExpired(s.jwt)) return null
  let d
  try {
    d = await call("GET", `${ZCODE}/api/v1/zcode-plan/billing/preview?app_version=${APP_VERSION}&platform=${platform()}`, { auth: "Bearer " + s.jwt, device: s.device })
  } catch {
    return null
  }
  const plans = (Array.isArray(d?.plans) ? d.plans : []).filter((p) => typeof p?.plan_id === "string" && p.plan_id.trim())
  if (!plans.length) return null
  const n = plans.length
  const plan = first(...plans.map((p) => (typeof p?.name === "string" ? p.name : "")), "ZCode gift plan")
  return { name: CLAIM_HINT, used: 0, aside: true, display: `${n} · ${plan}` }
}

const MCP = "MCP · Month"

// savedCard starts every card from the plan the sign-in saved, as magpie's
// built-in did: a reply without a level, a team detail that failed or an
// error keeps it. Each read keeps the sign-in (signIn): the built-in's
// marked no account lapsed, its expired Start Plan sign-in among them, and
// cleared none.
export function savedCard(out, plan) {
  if (plan && !out.plan) out.plan = plan
  // MCP reads as a footnote: its window goes last on the card
  if (Array.isArray(out.windows) && out.windows.some((w) => w.name === MCP))
    out.windows = [...out.windows.filter((w) => w.name !== MCP), ...out.windows.filter((w) => w.name === MCP)]
  out.signIn = "kept"
  return out
}

// usageOf is the auth hook's `usage`: the card for whichever plan the account is on.
export async function usageOf(getAuth, client, provider) {
  const auth = await getAuth()
  const s = stateOf(auth)
  if (!s) return { error: "not signed in", signIn: "kept" }
  const saved = (out) => savedCard(out, s.plan || auth?.plan)
  try {
    if (isTeam(s)) return saved(await teamUsage(s, await keyOf(s, auth, client, provider?.id ?? PROVIDER)))
    const { start, gift } = await plansOf(s)
    const card = saved(start ? await startUsage(s) : gift ? await dualUsage(s) : await codingUsage(s))
    // a gift plan ZCode holds for the account but has not put on it:
    // named on the card, claimed in the ZCode app (its claim needs
    // the app's captcha attestation, see claimHint). A card that is
    // an error keeps its error and asks nothing
    if (!card.error) {
      const hint = await claimHint(s)
      if (hint) card.windows = [...(card.windows ?? []), hint]
    }
    return card
  } catch (e) {
    return saved({ error: e?.message ?? String(e) })
  }
}
