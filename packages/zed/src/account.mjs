// An account as /client/users/me describes it, and as the sign-in is kept in OpenCode's auth entry.
import { parse } from "./json.mjs"

// who names the account: its GitHub login, its username, its name, its id.
export function who(me) {
  for (const s of [me.user?.github_login, me.user?.username, me.user?.name]) {
    if (typeof s === "string" && s.trim()) return s.trim()
  }
  if (me.user?.legacy_user_id) return String(me.user.legacy_user_id)
  return "Zed account"
}

// orgOf is the organization the account's models are asked under: its
// default one when it is among its organizations, else its first, as Zed
// picks it.
export function orgOf(me) {
  const orgs = me.organizations ?? []
  const def = orgs.find((o) => o.id === me.default_organization_id)
  if (def) return def.id
  if (orgs.length) return orgs[0].id
  return me.default_organization_id ?? ""
}

export const planOf = (me, org) => me.plans_by_organization?.[org] || me.plan?.plan_v3 || ""

export function modelsOff(me, org) {
  const c = me.configuration_by_organization?.[org]
  return !!c && c.is_zed_model_provider_enabled === false
}

// planName is a plan's id as a reader would name it.
export function planName(id) {
  const names = { zed_pro: "Pro", zed_pro_trial: "Pro Trial", zed_business: "Business", zed_student: "Student", zed_vip: "VIP", zed_free: "Free", "": "Free" }
  return names[id ?? ""] ?? String(id).replace(/^zed_/, "")
}

// The sign-in is kept as OpenCode's oauth entry: access is the account's
// access token, refresh the rest of what the calls need (Zed has no refresh
// token: the pair lasts until Zed refuses it), accountId its name.
export function stateOf(auth) {
  if (auth?.type !== "oauth" || !auth.access) return null
  const r = parse(auth.refresh ?? "")
  if (!r?.userId) return null
  return { access: auth.access, userId: String(r.userId), systemId: r.systemId ?? "", org: r.org ?? "", plan: r.plan ?? "", who: auth.accountId ?? "" }
}
