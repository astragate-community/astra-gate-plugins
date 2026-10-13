// The allowance card: the plan and how much of its quota is gone.
import { readUserStatus } from "./api.mjs"
import { failure } from "./refusals.mjs"

const num = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && !isNaN(Number(v)) ? Number(v) : 0)

// usageOf is the card for a GetUserStatus planStatus: the plan's end, the daily and weekly quotas a
// quota-billed plan has (the share left of each, and when it comes back), the ACUs a plan with a limit has
// used this cycle, and the extra usage balance. JSON leaves out what is zero, so a quota-billed plan's quota
// with a reset and no share is used up.
export function usageOf(st) {
  const info = st.planInfo ?? {}
  // no plan: the row keeps the one `devin auth status` gave the sign-in
  // ("Devin Pro"), as magpie's built-in row said it, not planName's "Pro"
  const out = { windows: [] }
  if (st.planEnd) out.until = st.planEnd
  // a quota's window is shown when Devin says what is left of it. JSON
  // leaves a 0 out, so on a quota-billed plan a window with a reset and no
  // share left is used up: a week at 0% left came as no weeklyQuota-
  // RemainingPercent beside the day's 100, and the day alone was shown
  // (面条 on magpie's Discord). Billed otherwise, a missing share is no quota.
  const quota = info.billingStrategy === "BILLING_STRATEGY_QUOTA"
  for (const [name, span, left, reset, hide] of [
    ["1 day", 24 * 3600, st.dailyQuotaRemainingPercent, st.dailyQuotaResetAtUnix, info.hideDailyQuota],
    ["7 days", 7 * 24 * 3600, st.weeklyQuotaRemainingPercent, st.weeklyQuotaResetAtUnix, info.hideWeeklyQuota],
  ]) {
    const at = num(reset)
    if (hide || ((left === undefined || left === null) && !(quota && at > 0))) continue
    out.windows.push({ name, used: Math.min(100, Math.max(0, 100 - num(left))), span, ...(at > 0 ? { resetsAt: at } : {}) })
  }
  const limit = num(st.acuLimit)
  if (limit > 0) {
    const used = num(st.acuConsumed)
    out.windows.push({ name: "ACUs", used: Math.min(100, (100 * used) / limit), display: `${+used.toFixed(2)} / ${+limit.toFixed(2)} ACUs`, ...(st.planEnd ? { resetsAt: st.planEnd } : {}), aside: true })
  }
  const extra = num(st.overageBalanceMicros)
  if (extra > 0) out.balance = "$" + (extra / 1e6).toFixed(2)
  return out
}

// usage is the account's plan and how much of its quota is gone, as
// GetUserStatus (what the CLI's /usage reads) tells them. magpie's built-in
// Devin account showed none of this.
export async function usage(key, server) {
  const { res, text, refused } = await readUserStatus(key, server)
  if (refused) return { error: "Devin's sign-in has expired — sign in again", windows: [] }
  if (!res.ok) return { error: failure(res.status, text).message, windows: [] }
  return usageOf(JSON.parse(text || "{}")?.userStatus?.planStatus ?? {})
}
