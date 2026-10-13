// Factory: the plan's usage.
//
// How much of the plan the account has used, as magpie's built-in Factory
// account shows it (internal/provider/factory_usage.go) and droid's /status
// asks it: GET /api/billing/limits. Standard usage runs in rolling 5-hour,
// weekly and monthly windows, each a percent used and when it ends; Droid
// Core, the open models Factory hosts, has windows of its own; extra usage
// is a balance in cents.
import { factoryGet } from "./api.mjs"
import { FactoryStatus } from "./errors.mjs"
import { CORE } from "./models.mjs"

// windowEnd reads a window's end: an ISO time or epoch milliseconds, as
// droid hands either to new Date.
export function windowEnd(v) {
  if (typeof v === "string" && v) {
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i.test(v) && !isNaN(Date.parse(v))) return new Date(v).toISOString()
    if (/^[+-]?\d+$/.test(v) && Number(v) > 0) return new Date(Number(v)).toISOString()
    return undefined
  }
  if (typeof v === "number" && v > 0) return new Date(Math.trunc(v)).toISOString()
  return undefined
}

// dollars is cents as Go's $%.2f writes them: a half cent rounds to even.
export function dollars(cents) {
  const x = cents / 100
  const tie = Number.isInteger(x * 8) && !Number.isInteger(x * 4) // .125, .375, .625, .875 exactly
  if (!tie) return "$" + x.toFixed(2)
  const lo = Math.floor(x * 100)
  return "$" + ((lo % 2 === 0 ? lo : lo + 1) / 100).toFixed(2)
}

// limitWindows turns the limits into windows: standard's by their span,
// then Droid Core's, then the extra usage left. For routing, standard counts
// the vendors' models and Core the open ones Factory hosts; with extra usage
// to spend, a window used up stops neither.
export function limitWindows(l) {
  const out = []
  const cents = typeof l.extraUsageBalanceCents === "number" ? l.extraUsageBalanceCents : null
  const extra = l.extraUsageAllowed === true && cents !== null && cents > 0
  const add = (p, prefix, core) => {
    if (!p || typeof p !== "object") return
    for (const [w, name, span] of [
      [p.fiveHour, "5 hours", 5 * 3600],
      [p.weekly, "7 days", 7 * 24 * 3600],
      [p.monthly, "30 days", 30 * 24 * 3600],
    ]) {
      if (!w || typeof w !== "object") continue
      const used = typeof w.usedPercent === "number" ? w.usedPercent : 0
      const win = { name: prefix + name, used: Math.min(Math.max(used, 0), 100), span }
      const end = windowEnd(w.windowEnd)
      if (end) win.resetsAt = end
      if (extra) win.aside = true
      if (core) win.models = CORE
      else win.notModels = CORE
      out.push(win)
    }
  }
  add(l.limits?.standard, "", false)
  add(l.limits?.core, "Droid Core · ", true)
  if (cents !== null && cents > 0) out.push({ name: "Extra usage", used: 0, display: dollars(cents), aside: true })
  return out
}

/**
 * The account's limits, asked once more when Factory refused an org that was put right. `signIn` is what the
 * read did to the built-in's lapse mark: a renewal took it off whatever came after, a refused one put it on, a
 * read that renewed nothing left it be (a clean read too).
 */
export async function readUsage({ fresh, mendOrg }) {
  let signIn = "kept"
  const onRenew = () => (signIn = "renewed")
  const limits = async () => factoryGet(await fresh(onRenew), "/api/billing/limits", 15_000)
  try {
    let l
    try {
      l = await limits()
    } catch (e) {
      if (!(e instanceof FactoryStatus && e.body !== undefined && (await mendOrg(e.code, e.body, onRenew).catch(() => false)))) throw e
      l = await limits()
    }
    if (!l?.limits?.standard) return { error: "Factory: the account reported no limits", signIn }
    return { windows: limitWindows(l), signIn }
  } catch (e) {
    if (e?.lapsed) signIn = "expired"
    return { error: e?.message ?? String(e), signIn }
  }
}
