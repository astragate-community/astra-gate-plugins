// The allowance card: the account's credit balance and, on ClinePass, the plan's 5-hour, weekly and monthly limits.
import { API } from "./constants.mjs"
import { clineApi } from "./api.mjs"
import { firstOf } from "./util.mjs"

// compactNumber is a whole number bare, else two decimals with the trailing
// zeroes off (magpie's subscription_usage.go)
export function compactNumber(n) {
  if (!Number.isFinite(n)) return "0"
  if (n === Math.trunc(n)) return String(Math.trunc(n))
  return String(Number(n.toFixed(2)))
}

// timeOf reads a reset time: epoch seconds, epoch ms, or a date string
export function timeOf(m, keys) {
  for (const k of keys) {
    const v = m?.[k]
    if (typeof v === "number" && v > 1e12) return new Date(v).toISOString()
    if (typeof v === "number" && v > 1e9) return new Date(v * 1000).toISOString()
    if (typeof v === "string") {
      const t = Date.parse(v)
      if (!Number.isNaN(t)) return new Date(t).toISOString()
    }
  }
  return ""
}

// usd is a dollar amount as it's usually written: cents above a cent, four
// decimals under one (an account with half a cent isn't "$0.00" to its owner)
export const usd = (n) => (n === 0 || n >= 0.01 ? `$${n.toFixed(2)}` : `$${Number(n.toFixed(4))}`)

// balanceUSD is the one balance shape Cline serves today: {balance} in
// millionths of a dollar — the chat gateway's current_balance is the same
// number with the decimal point moved six places
export function balanceUSD(v) {
  const n = typeof v?.balance === "number" ? v.balance : typeof v?.balance === "string" && Number.isFinite(Number(v.balance)) ? Number(v.balance) : NaN
  if (!Number.isFinite(n) || n < 0) return null
  return usd(n / 1e6)
}

// creditsOf is the account's credit balance, a shape Cline hasn't fixed: a
// total with what is used or left of it, or a count alone. A whole is what
// magpie says as used or as left, so it is { window } — carrying the count
// itself (amount of limit) for a card that says either. A count alone is no
// share of anything: what is left is { balance }, the card's balance, as
// magpie's built-in Cline says it; what is used alone is { window } set
// aside, a line that holds nothing up. (A window made of a count alone read
// as 0% used — its bar full, "100% left", whatever the balance.)
export function creditsOf(v) {
  if (!v || typeof v !== "object") return {}
  const flat = {}
  const collect = (n, depth) => {
    if (!n || typeof n !== "object" || depth > 2) return
    for (const [k, x] of Object.entries(n)) {
      if (typeof x === "number" && Number.isFinite(x)) flat[k.toLowerCase()] = x
      else if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x.trim()))) flat[k.toLowerCase()] = Number(x.trim())
      else collect(x, depth + 1)
    }
  }
  collect(v, 0)
  const pick = (keys) => {
    for (const k of keys) if (typeof flat[k] === "number") return flat[k]
    return NaN
  }
  const total = pick(["total", "totalcredits", "totalbalance", "creditstotal", "limit", "amount", "quota"])
  const used = pick(["used", "usedcredits", "usedamount", "spent", "consumed", "usagetotal"])
  const remaining = pick(["remaining", "remainingcredits", "remainingbalance", "left", "available", "balance", "credits", "current"])
  if (Number.isFinite(total) && total > 0) {
    const w = { name: "Credits", used: 0, limit: total }
    if (Number.isFinite(used)) {
      w.used = (100 * used) / total
      w.amount = used
      w.display = `${compactNumber(used)} / ${compactNumber(total)}`
    } else if (Number.isFinite(remaining) && remaining <= total) {
      w.used = (100 * (total - remaining)) / total
      w.amount = total - remaining
      w.display = `${compactNumber(total - remaining)} / ${compactNumber(total)}`
    } else return {}
    const at = timeOf(v, ["resetAt", "resetTime", "nextResetAt", "renewsAt", "expiresAt"])
    if (at) w.resetsAt = at
    return { window: w }
  }
  if (Number.isFinite(remaining) && remaining > 0) return { balance: `${compactNumber(remaining)} credits` }
  if (Number.isFinite(used) && used > 0) return { window: { name: "Credits", used: 0, aside: true, display: `${compactNumber(used)} credits used` } }
  return {}
}

// LIMITS are ClinePass's three limits as /users/me/plan/usage-limits names
// them (app.cline.bot's subscription page reads the same): a rolling 5
// hours, the calendar week and the calendar month
export const LIMITS = {
  five_hour: { name: "5 hours", span: 5 * 60 * 60 },
  weekly: { name: "Weekly", span: 7 * 24 * 60 * 60 },
  monthly: { name: "Month", span: 30 * 24 * 60 * 60 },
}

// limitWindows are the plan's limits, {limits: [{type, percentUsed,
// resetsAt}]}, in LIMITS' order; a type it doesn't know is left out, as the
// dashboard leaves it
export function limitWindows(v) {
  const out = []
  for (const l of Array.isArray(v?.limits) ? v.limits : []) {
    const k = LIMITS[l?.type]
    if (!k) continue
    const n = Number(l.percentUsed ?? 0)
    const w = { name: k.name, used: Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0)), span: k.span }
    const at = timeOf(l, ["resetsAt"])
    if (at) w.resetsAt = at
    out.push([Object.keys(LIMITS).indexOf(l.type), w])
  }
  return out.sort((a, b) => a[0] - b[0]).map(([, w]) => w)
}

export function usageOf(me, balance, limits) {
  const out = { windows: limitWindows(limits) }
  const plan = firstOf(me?.plan, me?.planType, me?.planName, me?.membership, me?.tier)
  if (plan) out.plan = plan
  // the credits as magpie says them: a window when Cline tells a whole to
  // be a share of, else the card's balance (magpie's built-in Cline, which
  // reads the same reply, says the same)
  const dollars = balanceUSD(balance)
  const credits = dollars ? {} : creditsOf(balance)
  if (credits.window) out.windows.push(credits.window)
  const left = dollars ?? credits.balance
  if (left) out.balance = left
  return out
}

// accountUsage is the account's credit balance and its ClinePass limits,
// magpie's own hook. A read the account's token couldn't make is the
// sign-in, not the read. The limits are asked alongside: a 404 there is
// an account without ClinePass, which has its credits alone (AxonHub's
// Cline checker reads it the same way); any other failure says so on the
// card rather than leaving the limits off unsaid (community plugins issue
// #79). Whichever of the two reads succeeds is shown when the other fails:
// windows read are kept when the balance can't be, as magpie's built-in
// key card keeps them.
export async function accountUsage(fresh, getAuth) {
  try {
    const cred = await fresh(getAuth)
    const authz = { Authorization: `Bearer ${cred.bearer}` }
    const limits = clineApi(`${API}/users/me/plan/usage-limits`, { headers: authz, lapsed: () => false }).then(
      (v) => ({ v }),
      (e) => (e?.status === 404 ? { v: null } : { e }),
    )
    let me = null
    let lastErr = null
    try {
      me = await clineApi(`${API}/users/me`, { headers: authz })
    } catch (e) {
      if (e?.expired) throw e
      lastErr = e
    }
    const ids = [me?.clineUserId, me?.subject, me?.id, cred.uid].filter((v) => typeof v === "string" && v.trim())
    let balance = null
    for (const id of ids) {
      try {
        balance = await clineApi(`${API}/users/${encodeURIComponent(id)}/balance`, { headers: authz })
        break
      } catch (e) {
        lastErr = e
      }
    }
    const lim = await limits
    const out = usageOf(me, balance, lim.v)
    if (!balance && !out.windows.length) throw lastErr ?? lim.e ?? new Error("Cline usage: no user id")
    if (lim.e) {
      // the words magpie's card knows (quotaError), the reason after
      const why = String(lim.e?.message ?? lim.e).replace(/^Cline(?: request failed)?:?\s*/, "")
      out.error = "ClinePass limits couldn't be read" + (why.startsWith("(") ? " " : ": ") + why
    }
    return { ...out, user: firstOf(cred.accountId, cred.email, cred.uid, ids[0]), signIn: cred.renewed ? "renewed" : "kept" }
  } catch (e) {
    return { windows: [], error: e?.message ?? String(e), signIn: e?.expired ? "expired" : "kept" }
  }
}
