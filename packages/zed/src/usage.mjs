// The allowance card: what the account says of its plan, as magpie's built-in Zed account shows it
// (zed_usage.go). Zed tells its editor the plan and its billing period, not how much of the allowance is
// spent, so there are no windows — the plan's name, when the period ends, and a plan Zed won't serve
// (overdue invoices) as the error it is.
import { cloud } from "./api.mjs"
import { orgOf, planName, planOf, stateOf } from "./account.mjs"
import { parse } from "./json.mjs"

// jsonError is what Go's encoding/json says of a /users/me reply it can't
// read into zed.Me.
export function jsonError(text, v) {
  if (v !== undefined) return `json: cannot unmarshal ${Array.isArray(v) ? "array" : typeof v === "string" ? "string" : typeof v === "number" ? "number" : "bool"} into Go value of type zed.Me`
  const c = String(text ?? "").trimStart()[0]
  return c === undefined ? "unexpected end of JSON input" : `invalid character '${c}' looking for beginning of value`
}

const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i

export async function usage(auth, save) {
  const s = stateOf(auth)
  // the built-in's read marked the account only when Zed refused its
  // sign-in, and took the mark off never: a clean read keeps it
  if (!s) return { error: "no such Zed account", signIn: "kept" }
  let me
  try {
    const text = await cloud("GET", "/client/users/me", s, undefined, 15_000)
    me = parse(text)
    if (me === null) me = {}
    else if (typeof me !== "object" || Array.isArray(me)) return { error: "Zed: an unreadable account: " + jsonError(text, me), signIn: "kept" }
  } catch (e) {
    if (e?.status === 401) return { error: `${s.who}: the Zed sign-in has expired — sign in again`, signIn: "expired" }
    return { error: e?.message ?? String(e), signIn: "kept" }
  }
  const plan = planOf(me, s.org || orgOf(me))
  const out = { plan: planName(plan), signIn: "kept" }
  if (plan !== s.plan && save) {
    const r = parse(auth.refresh ?? "") ?? {}
    await save({ ...auth, refresh: JSON.stringify({ ...r, plan, planName: out.plan }) }).catch(() => {})
  }
  const end = me.plan?.subscription_period?.ended_at
  if (typeof end === "string" && RFC3339.test(end) && !isNaN(Date.parse(end))) out.until = end
  if (me.plan?.has_overdue_invoices) out.error = "Zed: this account has an overdue invoice, so its models are paused (see zed.dev/account)"
  return out
}
