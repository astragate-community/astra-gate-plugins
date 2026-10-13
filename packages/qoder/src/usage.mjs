// Qoder: the account's allowance as magpie's built-in Qoder account shows it (internal/provider/qoder_usage.go):
// the account pages' usage, asked with the device token (not the job token the chat runs on), which is rotated
// with its own refresh token once Qoder refuses it.
import { API_TIMEOUT, deviceHeaders } from "./api.mjs"
import { UsageStatus } from "./errors.mjs"
import { siteOf } from "./sites.mjs"

// fetchUsage is the usage envelope, {displayMode, qoderUsage}.
export async function fetchUsage(site, deviceToken) {
  if (!String(deviceToken ?? "").trim()) throw new Error("qoder usage: missing device token")
  let res
  try {
    res = await fetch(site.openapi + "/sash/api/v2/me/usage", { headers: deviceHeaders(deviceToken), signal: AbortSignal.timeout(API_TIMEOUT) })
  } catch (e) {
    throw new Error(`qoder usage: request failed: ${e?.message ?? e}`)
  }
  if (res.status !== 200) throw new UsageStatus(res.status)
  let env
  try {
    env = JSON.parse(await res.text())
  } catch (e) {
    throw new Error(`qoder usage: decode response: ${e?.message ?? e}`)
  }
  if (env?.displayMode !== "qoder" && env?.displayMode !== "enterprise") throw new Error("qoder usage: unknown display mode")
  if (env.displayMode === "qoder" && (env.qoderUsage === undefined || env.qoderUsage === null)) throw new Error("qoder usage: missing quota data")
  return env
}

// gfmt is a number as Go's %g writes it.
export function gfmt(n) {
  const [m, e] = n.toExponential().split("e")
  const x = Number(e)
  if (x < -4 || x >= 6) return `${m}e${x < 0 ? "-" : "+"}${String(Math.abs(x)).padStart(2, "0")}`
  return String(n)
}

const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/i

// when is a time Qoder gives: an RFC 3339 string, else seconds or
// milliseconds, as a number or its text.
export function when(v) {
  if (typeof v === "string" && RFC3339.test(v) && !isNaN(Date.parse(v))) return new Date(v).toISOString()
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : NaN
  if (!isFinite(n) || n <= 0) return undefined
  return new Date(Math.trunc(n < 1e12 ? n * 1000 : n)).toISOString()
}

// parseUsage is the plan and each pool of credits the envelope tells.
export function parseUsage(env) {
  if (env.displayMode === "enterprise") return { plan: "Enterprise" }
  const u = env.qoderUsage
  if (env.displayMode !== "qoder" || !u || typeof u !== "object" || Array.isArray(u)) return { error: "Qoder: missing quota data" }
  const field = (a, b) => (u[a] !== undefined ? u[a] : u[b])
  const out = { windows: [] }
  const plan = field("userType", "user_type")
  if (typeof plan === "string") out.plan = plan
  const until = when(field("expiresAt", "expires_at"))
  if (until) out.until = until
  const num = (v) => v === undefined || v === null || typeof v === "number"
  const str = (v) => v === undefined || v === null || typeof v === "string"
  const add = (b, name) => {
    if (b === null || typeof b !== "object" || Array.isArray(b)) return
    if (![b.total, b.cap, b.used, b.remaining].every(num) || !str(b.name) || !str(b.unit)) return
    const total = b.total ?? b.cap
    if (total == null || total <= 0 || (b.used == null && b.remaining == null)) return
    const used = b.used != null ? b.used : total - b.remaining
    if (used < 0) return
    out.windows.push({ name: b.name || name, used: Math.min(100, (100 * used) / total), display: `${gfmt(used)} / ${gfmt(total)} ${b.unit || "credits"}` })
  }
  add(field("userQuota", "user_quota"), "Credits")
  add(field("addOnQuota", "add_on_quota"), "Add-on credits")
  add(field("orgResourcePackage", "org_resource_package"), "Shared credits")
  const dedicated = field("dedicatedResourcePackages", "dedicated_resource_packages")
  for (const b of Array.isArray(dedicated) ? dedicated : []) add(b, "Dedicated credits")
  return out
}

/**
 * The `auth.usage` hook. signIn is what the read means for the sign-in, as the built-in's did: a refused job
 * refresh marks it, a renewed one clears it, and nothing else does — not a clean read, nor a refused device
 * token, which serves only the account pages.
 */
export function createUsage(site, session) {
  return async (getAuth) => {
    let signIn = "kept"
    try {
      const cred = await session.fresh(getAuth)
      if (session.renewed(cred)) signIn = "renewed"
      let env
      try {
        env = await fetchUsage(siteOf(site, cred), cred.deviceToken)
      } catch (e) {
        if (!(e instanceof UsageStatus) || (e.status !== 401 && e.status !== 403)) throw e
        env = await fetchUsage(siteOf(site, cred), await session.deviceToken(getAuth, cred.deviceToken))
      }
      return { ...parseUsage(env), signIn }
    } catch (e) {
      return { error: e?.message ?? String(e), signIn: e?.expired ? "expired" : signIn }
    }
  }
}
