// The allowance card: how much of the plan's included usage is gone, and the on-demand spend.
import { statusText } from "@astragate-community/plugin-kit"
import { WEBSITE } from "./constants.mjs"
import { dashboard } from "./api.mjs"
import { jwtClaims } from "./jwt.mjs"

// How much of the plan's included usage is gone, as magpie's built-in Cursor
// account shows it (internal/provider/cursor_usage.go): the dashboard's
// current period, split into the Cursor Models and Other Models pools.

const POOL_VARIANT = /-(fast|none|low|medium|high|xhigh|extra-high|max|thinking)$/

// poolBase names a model's family: lower case, without cursor-, the
// context size the list adds to it (@300k) and the effort and speed the
// CLI adds to it.
export function poolBase(model) {
  model = String(model).trim().toLowerCase().replace(/@[^@]*$/, "")
  if (model.startsWith("cursor-")) model = model.slice("cursor-".length)
  for (;;) {
    const b = model.replace(POOL_VARIANT, "")
    if (b === model) return model
    model = b
  }
}

// Cursor's autoBucketModels can lag model releases: it still omitted Grok
// 4.6/4.7 when the published Cursor Models pool already included them.
// Keep those documented families alongside the server's exact model list.
// See https://cursor.com/docs/models-and-pricing.
function firstParty(model) {
  model = model.replace(/@[^@]*$/, "")
  if (model.startsWith("cursor-")) model = model.slice("cursor-".length)
  if (model === "default" || model === "composer" || model.startsWith("composer-")) return true
  return ["grok-4.5", "grok-4.6", "grok-4.7"].some((b) => model === b || model.startsWith(b + "-"))
}

// onDemandOf is what Cursor still serves once the included usage is spent,
// as cursor-agent's own usage view tells it (its On-demand line): from the
// period's spendLimitUsage (cents) and, where that sets no limit of the
// user's, GetHardLimit's reply (dollars; undefined when it couldn't be
// read). kind is "fixed" (up to limitDollars), "unlimited", "disabled" or
// "unavailable" (not known). A team member with no limit of their own
// spends the team's pool, which cursor-agent's view calls unlimited but
// which runs out at pooledLimit for the whole team (magpie #1868): that is
// a fixed limit on the pool's spend, with the member's own in mineDollars.
export function onDemandOf(data, hard) {
  const s = data?.spendLimitUsage
  const usedDollars = Number(s?.individualUsed ?? 0) / 100
  const own =
    s?.individualLimit === undefined
      ? undefined
      : Number(s.individualLimit) > 0
        ? { kind: "fixed", usedDollars, limitDollars: Number(s.individualLimit) / 100 }
        : { kind: "disabled", usedDollars }
  if (s?.limitType === "team") {
    if (own) return own
    if (hard && (hard.noUsageBasedAllowed || !(Number(hard.hardLimit) > 0))) return { kind: "disabled", usedDollars }
    // pooledLimit and pooledRemaining come as int64 strings, pooledUsed as a number
    const pool = Number(s.pooledLimit ?? 0)
    if (pool > 0) return { kind: "fixed", usedDollars: Number(s.pooledUsed ?? 0) / 100, limitDollars: pool / 100, mineDollars: usedDollars }
    return hard ? { kind: "unlimited", usedDollars } : { kind: "unavailable", usedDollars }
  }
  if (!hard) return own ?? { kind: "unavailable", usedDollars }
  if (hard.noUsageBasedAllowed) return { kind: "disabled", usedDollars }
  const limit = Number(hard.hardLimit ?? 0)
  if (limit >= 2147483647) return { kind: "unlimited", usedDollars }
  return limit > 0 ? { kind: "fixed", usedDollars, limitDollars: limit } : { kind: "disabled", usedDollars }
}

// hardLimit is GetHardLimit's reply, undefined when it couldn't be read.
async function hardLimit(tok) {
  try {
    const res = await dashboard(tok, "GetHardLimit")
    return res.ok ? ((await res.json()) ?? undefined) : undefined
  } catch {
    return undefined
  }
}

// dollars, thousands grouped: a team's pool runs to six figures ($451,200.00)
const dollars = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// usage is the account's windows this billing period; an enterprise plan
// reports spend instead, and gets none. ids are the models it can be
// asked for, each counted by the pool Cursor bills it to. An account that
// may spend on-demand once its included usage is gone (fottencity on
// Discord: a team that pays for more) is still served when the pools are
// spent, so they are shown aside, and its On-demand spend is what can run
// out: at its limit (a team member with none of their own: the team's
// pool), or never when it has none.
export async function allowance(tok, ids) {
  const [res, hard] = await Promise.all([
    dashboard(tok, "GetCurrentPeriodUsage"),
    hardLimit(tok),
  ])
  if (!res.ok) return { error: statusText(res.status), windows: [] }
  const data = await res.json()
  const u = data?.planUsage
  if (!u) return { windows: [] }
  const ms = /^[+-]?\d+$/.test(data.billingCycleEnd ?? "") ? Number(data.billingCycleEnd) : 0
  const resets = ms > 0 ? { resetsAt: new Date(ms).toISOString() } : {}
  const bucket = new Set((data.autoBucketModels ?? []).map(poolBase))
  const inPool = (model) => {
    model = poolBase(model)
    if (model === "auto") model = "default" // the CLI's Auto is default in Cursor's API
    // the server names a family (grok-4.8); the CLI asks for one at an
    // effort or speed (grok-4.8-high-fast)
    return bucket.has(model) || firstParty(model)
  }
  // Auto is always one, so the pool's list is never empty (which would
  // count every model). A model listed at its context sizes (grok-4.7@256k)
  // is still asked for by its bare name (grok-4.7) where it was picked
  // before the list had sizes, and runs as its default, so the pool names
  // that too (Will on Discord)
  const asked = ids.flatMap((id) => [id, id.replace(/@[^@]*$/, "")])
  const pool = [...new Set(["auto", ...asked, ...(data.autoBucketModels ?? [])])].filter(inPool)
  const num = (v) => (typeof v === "number" ? v : 0)
  const od = onDemandOf(data, hard)
  const pooled = od.kind === "fixed" || od.kind === "unlimited" ? { aside: true } : {}
  const onDemand =
    od.kind === "fixed"
      ? [{ name: "On-demand", used: Math.max(0, Math.min(100, (100 * od.usedDollars) / od.limitDollars)), display: `${dollars(od.usedDollars)} / ${dollars(od.limitDollars)}` + (od.mineDollars === undefined ? "" : ` (you: ${dollars(od.mineDollars)})`), ...resets }]
      : od.kind === "unlimited"
        ? [{ name: "On-demand", used: 0, display: dollars(od.usedDollars), ...resets, aside: true }]
        : []
  // the two pools fit the line; the total goes in its tooltip
  return {
    windows: [
      { name: "Cursor Models", used: num(u.autoPercentUsed), ...resets, models: pool, ...pooled },
      { name: "Other Models", used: num(u.apiPercentUsed), ...resets, notModels: pool, ...pooled },
      ...onDemand,
      { name: "Total", used: num(u.totalPercentUsed), ...resets, aside: true },
    ],
  }
}

// Grok Bot's separate allowance, using the CLI JWT as a dashboard session.
export async function botUsage(tok) {
  try {
    const subject = jwtClaims(tok).sub
    if (typeof subject !== "string") return []
    const user = subject.split("|").filter(Boolean).at(-1)
    if (!user || !/^[a-zA-Z0-9._-]+$/.test(user)) return []
    const res = await fetch(WEBSITE + "/api/dashboard/get-sand-usage-status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: WEBSITE,
        Cookie: "WorkosCursorSessionToken=" + encodeURIComponent(user + "::" + tok),
      },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return []
    const data = await res.json()
    const paid = typeof data?.includedLimitZero === "boolean"
      ? !data.includedLimitZero : data?.hasNonZeroIncludedLimit === true
    const trial = !paid && typeof data?.sandTrialExpiresAt === "string" && Date.parse(data.sandTrialExpiresAt) > Date.now()
    if ((!paid && !trial) || typeof data?.usagePercent !== "number" || !Number.isFinite(data.usagePercent)) return []
    const reset = paid && typeof data.nextResetTimestampUtc === "string" ? Date.parse(data.nextResetTimestampUtc) : NaN
    return [{
      name: trial ? "Grok Bot (trial)" : "Grok Bot",
      used: Math.max(0, Math.min(100, data.usagePercent)),
      aside: true, // Bot exhaustion must not stop Cursor model requests.
      ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString(), span: 604800 } : {}),
    }]
  } catch {
    return []
  }
}
