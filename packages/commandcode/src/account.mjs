// The account as billing reports it: the plan (the subscription, cached because it is slow), and the credits
// beyond the plan's. magpie's built-in Command Code account reads the same (internal/provider/commandcode_plan.go).
import { API } from "./constants.mjs"
import { number, when } from "./values.mjs"

export async function accountJSON(path, key, timeout = 15_000) {
  const res = await fetch(API + path, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) {
    const e = new Error(`${path}: ${res.status}`)
    e.status = res.status
    throw e
  }
  return res.json()
}

// The plan names, by planId prefix, the longest first, with the dollars of
// credits each gives a month (the CLI's getPlanInfo; "individual-pro-v1"
// is the old Pro, $80 of them).
const PLAN_NAMES = [
  ["individual-provider", "Provider", 15],
  ["individual-pro-v1", "Pro", 80],
  ["individual-goat", "GOAT", 70],
  ["individual-ultra", "Ultra", 300],
  ["individual-max", "Max", 150],
  ["individual-pro", "Pro", 30],
  ["individual-go", "Go", 10],
  ["teams-pro", "Teams Pro", 40],
]
const NO_PLAN = "No plan"

// planOf is [prefix, name, monthly dollars] for a planId, or ["", "", 0].
export function planOf(id) {
  const s = String(id ?? "").toLowerCase().replaceAll("_", "-")
  return PLAN_NAMES.find(([p]) => s.startsWith(p)) ?? ["", "", 0]
}

const planName = (id) => planOf(id)[1]

// subscriptionOf is the account's plan as billing/subscriptions says: its
// id and name, when its period ends and whether it renews then; NO_PLAN
// when it has none, undefined when it can't be read.
export async function subscriptionOf(key, timeout) {
  let d
  try {
    const r = await accountJSON("/alpha/billing/subscriptions", key, timeout)
    // a 200 with success false when Command Code couldn't tell
    // ("write CONNECTION_CLOSED …"): unread, not no plan
    if (r?.success === false) return undefined
    d = r?.data
  } catch {
    return undefined
  }
  if (d?.planId && d.status !== "canceled" && d.status !== "incomplete_expired") {
    const renew = typeof d.cancelAtPeriodEnd === "boolean" ? (d.cancelAtPeriodEnd ? "off" : "auto") : ""
    return { id: d.planId, plan: planName(d.planId) || d.planId, until: when(d.currentPeriodEnd), renew }
  }
  return { id: "", plan: NO_PLAN }
}

// Each key's subscription as last read, and the reading under way.
// billing/subscriptions takes 15–20 seconds at times, longer than magpie
// waits for a card (15): the allowance waits for it waits.subWait at most, then
// goes with the one read before while the reading goes on for next time.
export const subsSeen = new Map()
const SUB_KEEP = 10 * 60 * 1000
export const waits = { subWait: 9_000, creditWait: 5_000 }

export function subscriptionNow(key, wait = waits.subWait) {
  const seen = subsSeen.get(key) ?? {}
  if (seen.sub && Date.now() - seen.at < SUB_KEEP) return Promise.resolve(seen.sub)
  if (!seen.reading) {
    seen.reading = subscriptionOf(key, 60_000).then((sub) => {
      const now = subsSeen.get(key) ?? {}
      subsSeen.set(key, sub ? { sub, at: Date.now() } : { sub: now.sub, at: now.at })
      return sub
    })
    subsSeen.set(key, seen)
  }
  let timer
  const late = new Promise((r) => (timer = setTimeout(() => r(seen.sub), wait)))
  return Promise.race([seen.reading.then((sub) => sub ?? seen.sub), late]).finally(() => clearTimeout(timer))
}

// planNow is the account's plan, for the models and the endpoint Go takes:
// the subscription read in the last ten minutes, else read now, with the
// plan the sign-in saved going meanwhile when it takes more than a moment.
export async function planNow(key, saved) {
  return (await subscriptionNow(key, saved ? 2_000 : waits.subWait))?.plan || saved || ""
}

// Each key's credits beyond its plan's, as last read: bought or free ones
// let the account every model, the plan's or not (the CLI's
// evaluateModelAccess; Command Code's refusal: "… or extra on demand
// usage").
export const extraSeen = new Map()
export const hasExtra = (c) => number(c?.credits?.purchasedCredits) > 0 || number(c?.credits?.freeCredits) > 0

// extraNow is whether the key has such credits: read now, else as last
// read, else none, so the plan's list stands when they can't be read and
// a model it leaves out is still refused by Command Code, as it was asked.
export async function extraNow(key) {
  try {
    const v = hasExtra(await accountJSON("/alpha/billing/credits", key, waits.creditWait))
    extraSeen.set(key, v)
    return v
  } catch {
    return extraSeen.get(key) ?? false
  }
}
