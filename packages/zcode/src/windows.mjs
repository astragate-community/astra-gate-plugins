// The allowance card's maths: Z.ai's limits, terms and times read into windows.
import { isNum, startNum } from "./util.mjs"

// spanOf reads a limit's window, in seconds: unit 3 counts hours, 6 weeks
// (and 1, 4, 5 minutes, days and months by the same count). A team's five
// hours come with no count.
export function spanOf(unit, n) {
  n = Math.trunc(Number(n) || 0)
  if (unit === 3 && n <= 0) n = 5
  n = Math.max(n, 1)
  return { 1: 60, 3: 3600, 4: 86400, 5: 30 * 86400, 6: 7 * 86400 }[unit] * n || 0
}

export function windowName(span) {
  if (span === 0) return "Credits"
  if (span < 86400) return `${Math.trunc(span / 3600)} hours`
  if (span === 7 * 86400) return "Weekly"
  if (span >= 28 * 86400) return "Monthly"
  return `${Math.trunc(span / 86400)} days`
}

// compact is a count as magpie says one: whole, else to two places.
export const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

// limitWindows are /api/monitor/usage/quota/limit's limits as windows: what
// is used of the whole when both are told (the whole less what remains, or
// the current value), else the percentage given. TIME_LIMIT is the month's
// MCP tool calls, which ZCode shows but never stops the models on, so it is
// set aside, as is a limit whose whole is told as 0: no cap (an older
// plan's), which the vendor may still give as 100% used. A window whose
// count is told carries it as amount of limit, so magpie's card says the
// count as used or as left, as it says the share beside it (#659).
export function limitWindows(d) {
  const out = []
  for (const x of d?.limits ?? []) {
    const span = spanOf(Math.trunc(Number(x?.unit) || 0), x?.number)
    const w = { name: windowName(span), used: 0 }
    if (String(x?.type ?? "").toUpperCase() === "TIME_LIMIT") (w.name = "MCP · Month"), (w.aside = true)
    if (isNum(x?.percentage)) w.used = x.percentage
    if (x?.usage === 0) (w.used = 0), (w.aside = true)
    if (isNum(x?.usage) && x.usage > 0) {
      const total = x.usage
      if (isNum(x.remaining)) {
        const used = total - x.remaining
        w.used = (100 * used) / total
        w.amount = used
        w.limit = total
        w.display = `${compact(used)} / ${compact(total)}`
      } else if (isNum(x.currentValue)) {
        if (!isNum(x.percentage)) w.used = (100 * x.currentValue) / total
        w.amount = x.currentValue
        w.limit = total
        w.display = `${compact(x.currentValue)} / ${compact(total)}`
      }
    }
    const reset = Math.trunc(Number(x?.nextResetTime) || 0)
    if (reset > 0) w.resetsAt = new Date(reset).toISOString()
    if (span) w.span = span
    out.push(w)
  }
  return out
}

// beijing reads the plan's times, "2026-10-18 12:00:00" in Beijing: ms, or 0.
export function beijing(s) {
  s = String(s ?? "").trim().replace(" ", "T")
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/.test(s)) return 0
  const t = Date.parse(s + (s.length === 10 ? "T00:00:00" : "") + "+08:00")
  return Number.isFinite(t) ? t : 0
}

// termOf is how long a GLM Coding plan is paid for: the valid
// subscription's next renewal, a charge when it renews itself, else the
// end of its time, the last date its "valid" span names.
export function termOf(subs) {
  for (const x of Array.isArray(subs) ? subs : []) {
    if (String(x?.status ?? "").toUpperCase() !== "VALID") continue
    const auto = x.autoRenew === true || x.autoRenew === 1
    const t = beijing(typeof x.nextRenewTime === "string" ? x.nextRenewTime : "")
    if (t) return { until: new Date(t).toISOString(), renew: auto ? "auto" : "off" }
    const ds = String(typeof x.valid === "string" ? x.valid : "").match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?/g) ?? []
    if (ds.length && !auto) {
      const end = beijing(ds[ds.length - 1])
      if (end) return { until: new Date(end).toISOString(), renew: "off" }
    }
    return {}
  }
  return {}
}

// periodOf reads an entitlement's period: "daily", "weekly", "monthly".
export function periodOf(p) {
  p = p.toLowerCase()
  if (p.includes("day") || p.includes("daily")) return 86400
  if (p.includes("week")) return 7 * 86400
  if (p.includes("month")) return 30 * 86400
  return 0
}

// when is a team plan's end: a time in Beijing, or a Unix time in seconds
// or milliseconds; ms, or 0.
export function when(v) {
  if (typeof v === "string") {
    const t = beijing(v)
    if (t) return t
  }
  const n = startNum(v)
  if (n > 0) return n > 1e12 ? Math.trunc(n) : Math.trunc(n) * 1000
  return 0
}
