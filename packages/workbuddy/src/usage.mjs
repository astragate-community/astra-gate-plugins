// WorkBuddy: an account's credits and when they run out.
import { meter } from "./api.mjs"

// capacity is a capacity the billing API sends, as a string ("438.88")
// or now and then a number; empty is 0.
function capacity(v) {
  if (v == null || v === "") return 0
  if (typeof v === "number") return v
  const s = String(v)
  const n = Number(s)
  if (s.trim() !== s || Number.isNaN(n)) throw new Error(`strconv.ParseFloat: parsing ${JSON.stringify(s)}: invalid syntax`)
  return n
}

// compact is a count as magpie says one: whole, else to two places.
const compact = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

// usageOf is the account's credits, from its resource summary: the plan's
// credits used against what the cycle grants, as magpie's built-in said —
// the count itself too (amount of limit, in credits), for magpie to say it
// as used or left beside the share (magpie#659).
export function usageOf(sum, plan) {
  const out = { plan: plan || (sum?.IsPaidUser ? "Pro" : "Free"), windows: [] }
  let total = 0, used = 0
  for (const p of sum?.Packages ?? []) {
    total += capacity(p?.CycleTotalCapacity)
    used += capacity(p?.CycleUsedCapacity)
  }
  if (total > 0) out.windows.push({ name: "Credits", used: (100 * used) / total, display: `${compact(used)} / ${compact(total)}`, amount: used, limit: total, unit: "credits" })
  return out
}

// enterpriseUsageOf is an enterprise (team) account's credits, from
// /billing/meter/get-enterprise-user-usage, the meter WorkBuddy's own usage
// page (www.workbuddy.cn/profile/usage) reads for one (magpie #1904,
// CnsMaple): the resource summary answers such an account with no
// packages at all. It counts the cycle's credits flat — credit used of
// limitNum — and when the cycle began and resets (UTC+8). null when it
// grants none.
export function enterpriseUsageOf(u) {
  const limit = capacity(u?.limitNum)
  if (!(limit > 0)) return null
  const used = capacity(u?.credit)
  const w = { name: "Credits", used: (100 * used) / limit, display: `${compact(used)} / ${compact(limit)}`, amount: used, limit, unit: "credits" }
  const at = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v.trim()) ? Date.parse(v.trim().replace(" ", "T") + "+08:00") : 0)
  const reset = at(u?.cycleResetTime), start = at(u?.cycleStartTime)
  if (reset > 0) w.resetsAt = new Date(reset).toISOString()
  if (reset > start && start > 0) w.span = (reset - start) / 1000
  return w
}

// The packages' codes, as WorkBuddy's own client lists them when it asks
// for each package's credits (its COMMODITY_CODES): the API refuses a
// detail list without them (10001 "PackageCodes required").
const CODE = (n, s) => `TCACA_code_${n}_${s}`
const PAID_CODES = [CODE("002", "AkiJS3ZHF5"), CODE("005", "maRGyrHhw1"), CODE("003", "FAnt7lcmRT"), CODE("023", "4xbGhMrE6q"),
  CODE("026", "BaESVICNoi"), CODE("027", "0FCGVA6vSa"), CODE("009", "0XmEQc2xOf"), CODE("038", "OhvqZtiPKr"), CODE("036", "lupO5WgNdG")]
const DAILY_CODE = CODE("001", "PqouKr6QWV")
const FREE_CODES = [DAILY_CODE, CODE("008", "cfWoLwvjU4"), CODE("035", "ArVxJcGDsm"), CODE("006", "DbXS0lrypC"), CODE("039", "KRcQj7wUat"),
  CODE("040", "mi9rCYg46x"), CODE("007", "nzdH5h4Nl0"), CODE("028", "NtpWi0jzXs"), CODE("037", "WxOD3MpI2o"), CODE("029", "6wCGEWquYy"),
  CODE("030", "BjSt89qTvr")]
// a slice package (CapacityType 4) is refreshed each day: its credits are
// lost at the same midnight on every account, so they tell none apart
const SLICE = "4"

// beijing is WorkBuddy's own time ("2026-10-13 00:39:27" is UTC+8, as its
// DeductionEndTime for the same package says).
const beijing = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ")

// packagesOf is every package of the account with credits, paid and free,
// as WorkBuddy's client asks for them: active and used-up (Status 0, 3),
// up to 10 pages of 200.
export async function packagesOf(site, a, now = Date.now()) {
  const day = beijing(now).slice(0, 10)
  const lists = [
    ["/billing/meter/get-user-resource-paid-packages", { PackageCodes: PAID_CODES, NeedRenewInfo: true }],
    ["/billing/meter/get-user-resource-free-packages", { PackageCodes: FREE_CODES, SlicePeriodStartTime: day + " 00:00:00", SlicePeriodEndTime: day + " 23:59:59" }],
  ]
  const out = []
  for (const [path, extra] of lists) {
    for (let page = 1; page <= 10; page++) {
      const d = await meter(site, a, path, { PageNumber: page, PageSize: 200, Status: [0, 3], ...extra })
      const got = d?.Accounts ?? []
      out.push(...got)
      if (got.length < 200 || out.length >= (d?.TotalCount ?? 0)) break
    }
  }
  return out
}

// endOf is when a package's credits are lost: its DeductionEndTime, else
// ExpiredTime, else the cycle's end (UTC+8), as WorkBuddy's client reads it.
function endOf(p) {
  const ms = Number(p?.DeductionEndTime)
  if (ms > 0) return ms
  for (const v of [p?.ExpiredTime, p?.CycleEndTime]) {
    if (typeof v !== "string" || !v.trim()) continue
    const t = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v.trim()) ? Date.parse(v.trim().replace(" ", "T") + "+08:00") : Date.parse(v)
    if (t > 0) return t
  }
  return 0
}

// runsOutOf is the soonest moment credits left in one of the account's
// packages are lost, and how many (cdredfox on X): smart routing spends
// the account whose credits expire first. Only packages the summary
// counts, with credits left, and not the daily slice; null when none.
export function runsOutOf(sum, packages, now = Date.now()) {
  const counted = new Set((sum?.Packages ?? []).map((p) => p?.PackageCode))
  let at = 0, amount = 0
  for (const p of packages ?? []) {
    if (!counted.has(p?.PackageCode) || p?.PackageCode === DAILY_CODE || String(p?.CapacityType) === SLICE) continue
    const left = capacity(p?.CycleCapacityRemainPrecise ?? p?.CycleCapacityRemain)
    const end = endOf(p)
    if (!(left > 0) || end <= now) continue
    if (!at || end < at) at = end, amount = left
    else if (end === at) amount += left
  }
  return at ? { runsOutAt: new Date(at).toISOString(), runsOut: amount } : null
}