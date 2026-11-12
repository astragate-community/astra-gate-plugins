// Kiro: the allowance card — Get-Usage-Limits as magpie's built-in showed it.

// planName is the subscription's name as Kiro gives it ("KIRO FREE"), said
// "Kiro Free".
export const planName = (title) =>
  String(title ?? "").toLowerCase().split(/\s+/).filter(Boolean).map((w) => (w === "kiro" ? "Kiro" : w[0].toUpperCase() + w.slice(1))).join(" ")

// goG is Go's %g of x: an exponent from a million up.
export function goG(x) {
  const [m, e] = x.toExponential().split("e")
  const exp = Number(e)
  if (exp < -4 || exp >= 6) return `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`
  return String(x)
}

const at = (secs) => (secs > 0 ? new Date(Math.trunc(secs) * 1000).toISOString() : undefined)
const count = (used, limit) => used.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") + " / " + goG(limit)
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0)

// usageOf is the allowance Get-Usage-Limits tells, as magpie's built-in
// said it: the account's email, the credits of each allowance, the month's and a free trial's
// while it runs.
export function usageOf(l) {
  const windows = []
  for (const u of l?.usageBreakdownList ?? []) {
    const t = u?.freeTrialInfo
    if (t && String(t.freeTrialStatus ?? "").toUpperCase() === "ACTIVE" && num(t.usageLimitWithPrecision) > 0) {
      const used = num(t.currentUsageWithPrecision), limit = num(t.usageLimitWithPrecision)
      windows.push({ name: "Free trial", used: (100 * used) / limit, resetsAt: at(num(t.freeTrialExpiry)), display: count(used, limit) })
    }
    const used = num(u?.currentUsageWithPrecision), limit = num(u?.usageLimitWithPrecision)
    if (limit <= 0) continue
    const reset = num(u?.nextDateReset) || num(l?.nextDateReset)
    windows.push({ name: u?.displayNamePlural || u?.displayName || "Credits", used: (100 * used) / limit, resetsAt: at(reset),
      display: count(used, limit), span: 30 * 24 * 3600 })
  }
  const email = l?.userInfo?.email
  return { plan: planName(l?.subscriptionInfo?.subscriptionTitle), ...(typeof email === "string" && email ? { user: email } : {}), windows }
}
