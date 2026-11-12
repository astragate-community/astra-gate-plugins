// Kiro: an account's tokens — refreshing, and keeping fresh. The host keeps one secret per account; here it is the
// sign-in as JSON: { method: "apikey" | "social" | "idc", access, refresh, expires, region, profile, loginProvider,
// clientId, clientSecret, builderID }.
import { http, providers } from "astra"
import { DESKTOP_UA, EARLY_MS, ID, oidc, refreshURL } from "./constants.js"
import { EXPIRED, gone, statusLine } from "./errors.js"
import { profileOf, regionOf, tokenType } from "./api.js"

export const fresh = (c, early = EARLY_MS) => c.method === "apikey" || !c.expires || c.expires - Date.now() > early

export function readSecret(text) {
  try {
    const c = JSON.parse(String(text ?? ""))
    return c && typeof c === "object" ? c : null
  } catch {
    return null
  }
}

// post is a token refresh's request.
async function post(url, body, headers = {}) {
  let res
  try {
    res = await http.fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...headers }, body, timeoutMs: 4_000 })
  } catch (e) {
    throw new Error("refreshing Kiro's sign-in: " + (e?.message ?? e))
  }
  const text = await res.text()
  if (!res.ok) {
    if ([400, 401, 403].includes(res.status)) throw gone(EXPIRED)
    throw new Error(`refreshing Kiro's sign-in: ${statusLine(res.status)}`)
  }
  return JSON.parse(text)
}

// exchange trades a sign-in's refresh token at its own token endpoint and
// gives back what came, in one shape: { access, refresh, expiresIn }.
async function exchange(c) {
  switch (c.method) {
    case "social": {
      const r = await post(refreshURL(c.region), JSON.stringify({ refreshToken: c.refresh }), { "User-Agent": DESKTOP_UA })
      if (r.profileArn) c.profile = r.profileArn
      return { access: r.accessToken, refresh: r.refreshToken, expiresIn: r.expiresIn }
    }
    case "idc": {
      const r = await post(oidc(c.region) + "/token", JSON.stringify({ clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refresh, grantType: "refresh_token" }))
      return { access: r.accessToken, refresh: r.refreshToken, expiresIn: r.expiresIn }
    }
    default:
      throw gone("Kiro's sign-in has expired")
  }
}

// refresh refreshes a sign-in's token.
export async function refresh(c) {
  if (!c.refresh) throw gone(EXPIRED)
  const n = { ...c }
  const out = await exchange(n)
  if (!out.access) throw gone(EXPIRED)
  n.access = out.access
  n.expires = Date.now() + (out.expiresIn > 0 ? out.expiresIn : 3600) * 1000
  if (out.refresh) n.refresh = out.refresh
  return n
}

// one refresh at a time, as a refresh may replace the refresh token
let lock = Promise.resolve()
const locked = (fn) => {
  const run = lock.then(fn, fn)
  lock = run.catch(() => {})
  return run
}

/**
 * What a request needs of an account: { token, tokenType, profile, region }. The token is refreshed when near its end
 * (or, with `force`, always: Kiro just turned it down) and the profile found the first time; what changed is written
 * back into the account's secret.
 */
export const creds = (account, { force = false } = {}) =>
  locked(async () => {
    if (!account) throw gone("this Kiro account is not there; add it again")
    const before = readSecret(await account.secret())
    if (!before?.access) throw gone("this Kiro account's sign-in is gone; add it again")
    let c = { region: "us-east-1", profile: "", ...before }
    if (!fresh(c) || force) {
      if (c.method === "apikey") throw gone("Kiro turned down the API key saved on the provider")
      c = await refresh(c)
    }
    if (!c.profile) c.profile = await profileOf(c)
    if (c.access !== before.access || c.profile !== before.profile || c.refresh !== before.refresh) await providers.accounts.update(ID, account.key, { secret: JSON.stringify(c) })
    return { token: c.access, tokenType: tokenType(c), profile: c.profile, region: regionOf(c.profile, c.region) }
  })
