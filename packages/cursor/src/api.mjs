// Cursor's JSON (Connect) API: the headers it is called with, and the account questions asked of it.
import { clientVersion } from "./cli.mjs"
import { failure, httpError } from "./errors.mjs"
import { API } from "./constants.mjs"

export async function headersFor(tok) {
  return {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
    ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    "x-cursor-client-version": await clientVersion(),
    "x-cursor-client-type": "cli",
    "x-ghost-mode": "true",
  }
}

// unary is a Connect call in JSON.
export async function unary(base, path, tok, body = {}, timeout = 15_000) {
  const res = await fetch(base + "/" + path, {
    method: "POST",
    headers: await headersFor(tok),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  if (!res.ok) {
    const f = failure(res.status, text)
    throw httpError(f.message, f.status)
  }
  return JSON.parse(text || "{}")
}

// planName is the plan's name, as `cursor-agent about` says it (GetPlanInfo's planName); "" when Cursor names none.
export async function planName(tok) {
  return String((await unary(API, "aiserver.v1.DashboardService/GetPlanInfo", tok))?.planInfo?.planName ?? "").trim()
}

// whoIs is the account's email and plan, as `cursor-agent about` says them.
export async function whoIs(tok) {
  const [me, plan] = await Promise.allSettled([unary(API, "aiserver.v1.DashboardService/GetMe", tok), planName(tok)])
  return {
    email: me.status === "fulfilled" ? String(me.value?.email ?? "").trim() : "",
    plan: plan.status === "fulfilled" ? plan.value : "",
  }
}

// dashboard is a call of the dashboard service with an empty body, the answer as it came; made with the
// token alone, without the CLI's client headers.
export const dashboard = (tok, method) =>
  fetch(API + "/aiserver.v1.DashboardService/" + method, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  })

// plans are the plan each token's account is on, as `cursor-agent about`
// names it (GetPlanInfo's planName, magpie's card title), asked again after
// an hour.
const plans = new Map()
const PLAN_TTL = 3600_000
export async function planOf(tok) {
  const had = plans.get(tok)
  if (had && Date.now() - had.at < PLAN_TTL) return had.plan
  try {
    const plan = await planName(tok)
    if (plan) plans.set(tok, { plan, at: Date.now() })
    return plan || had?.plan || ""
  } catch {
    return had?.plan ?? ""
  }
}
