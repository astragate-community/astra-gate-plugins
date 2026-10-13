// The allowance card: the plan's windows and credits, as magpie's built-in Command Code account shows it
// (internal/provider/commandcode_plan.go, cmdQuota)
import { statusText } from "@astragate-community/plugin-kit"
import { accountJSON, extraSeen, hasExtra, planOf, subscriptionNow, waits } from "./account.mjs"
import { money, number, when } from "./values.mjs"

// limits is the plan's 5-hour and weekly windows in a credits reply,
// those it gives a cap.
export function limits(c) {
  const out = []
  const w = c?.windowLimits
  if (!w) return out
  for (const [name, span, x] of [["5 hours", 5 * 3600, w.fiveHour], ["Weekly", 7 * 24 * 3600, w.weekly]]) {
    if (!x) continue
    const used = number(x.used)
    const cap = number(x.cap)
    if (used === undefined || cap === undefined || !(cap > 0)) continue
    const at = when(x.resetAt)
    out.push({ name, used: Math.min(100, (100 * Math.max(0, used)) / cap), span, ...(at ? { resetsAt: at } : {}) })
  }
  return out
}

// allowanceOf makes a credits reply into the plan's windows: the 5-hour
// and weekly limits, and the dollars as one more, used of the CLI's pool
// (the plan's month of credits, or what is left of it if more, and the
// bought and free ones) as its /usage bar is. A reply with neither windows
// nor a plan tells a balance: a key's money, not an allowance.
export function allowanceOf(c) {
  const out = { windows: limits(c) }
  const [, name, planMonthly] = planOf(c?.credits?.planId)
  if (name) out.plan = name
  let monthly = 0
  let left = 0
  let known = false
  for (const [i, v] of [c?.credits?.monthlyCredits, c?.credits?.purchasedCredits, c?.credits?.freeCredits].entries()) {
    let n = number(v)
    if (n === undefined) continue
    n = Math.max(0, n)
    if (i === 0) monthly = n
    left += n
    known = true
  }
  if (known && planMonthly > 0) {
    const pool = Math.max(planMonthly, monthly) + left - monthly
    out.windows.push({ name: "Credits", used: Math.min(100, (100 * (pool - left)) / pool), display: money(pool - left) + " / " + money(pool) })
  } else if (known && !out.windows.length) out.balance = money(left)
  return out
}

// usage is the account's allowance, and the subscription read for it. The
// plan is said even while the credits can't be read (Command Code answers
// 503, "Couldn't verify your credit balance just now", at times), and the
// plan saved (saved: { id, plan }) stands for the subscription while it
// can't be read, or is slow to: then it is waited for a moment only.
export async function usage(key, saved) {
  const [read, credits] = await Promise.all([
    subscriptionNow(key, saved ? 2_000 : waits.subWait),
    accountJSON("/alpha/billing/credits", key, 12_000).then(
      (c) => ({ c }),
      (e) => ({ e }),
    ),
  ])
  const sub = read ?? saved
  let out = { windows: [] }
  if (credits.e) out.error = credits.e.status ? statusText(credits.e.status) : credits.e.message
  else {
    // billing/credits leaves the plan out: the month of credits the pool
    // is made of is the subscription's plan's
    const c = credits.c ?? {}
    extraSeen.set(key, hasExtra(c))
    out = allowanceOf({ ...c, credits: { ...(c.credits ?? {}), planId: c.credits?.planId || sub?.id || "" } })
  }
  if (sub) {
    out.plan = sub.plan
    if (sub.until) out.until = sub.until
    if (sub.renew) out.renew = sub.renew
  }
  return { out, read }
}
