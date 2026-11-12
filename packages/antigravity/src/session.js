// Antigravity: an account's tokens — refreshing them, and finding the project its requests are billed to.
// The host keeps one secret per account; here it is the sign-in as JSON: { access, refresh, expires, project, plan, tier, paid }.
import { providers } from "astra";
import { EARLY_MS, ID } from "./constants.js"
import { EXPIRED, gone } from "./errors.js"
import { refreshToken, setup } from "./api.js"
import { oauthClient } from "./oauth.js"

export function readSecret(text) {
  try {
    const c = JSON.parse(String(text ?? ""))
    return c && typeof c === "object" ? c : null
  } catch {
    return null
  }
}

/** Is there a sign-in to use: a Google account with a refresh token. */
export const hasSignIn = (c) => !!c && typeof c.refresh === "string" && c.refresh.length > 0

/** Is a token good for a while yet. */
export const fresh = (c, early = EARLY_MS) => !!c.access && Number(c.expires) - Date.now() > early

// Google says a refresh token is no good this way; anything else (the network, Google being down) is no verdict on it
const TURNED_DOWN = new Set(["invalid_grant", "invalid_client", "unauthorized_client"])

/** A new access token for the sign-in c. Google's refresh tokens don't turn over, so the refresh token stays. */
export async function refresh(c, client = oauthClient()) {
  if (!c.refresh) throw gone(EXPIRED)
  let t
  try {
    t = await refreshToken(client, c.refresh)
  } catch (e) {
    if (TURNED_DOWN.has(e?.code)) throw gone(`${EXPIRED} (Google: ${e.message})`)
    throw e
  }
  if (!t.access_token) throw new Error("Google sent back no access token")
  return { ...c, access: t.access_token, expires: Date.now() + (t.expires_in > 0 ? t.expires_in : 3600) * 1000 }
}

// one refresh at a time
let lock = Promise.resolve()
const locked = (fn) => {
  const run = lock.then(fn, fn)
  lock = run.catch(() => {})
  return run
}

/**
 * What a request needs of an account: { token, project, tier, paid, plan }. The token is refreshed when near its end
 * (or, with `force`, always: Google just turned it down), and the project asked of Code Assist the first time. What was
 * learned is written back into the account's secret.
 */
export const creds = (account, { force = false } = {}) =>
  locked(async () => {
    if (!account) throw gone("this Antigravity account is not there; add it again")
    const before = readSecret(await account.secret())
    if (!hasSignIn(before)) throw gone("this Antigravity account's sign-in is gone; add it again")
    let c = { access: "", expires: 0, project: "", plan: "", tier: "", paid: "", ...before }
    if (!fresh(c) || force) c = await refresh(c)
    if (!c.project) {
      const s = await setup(c.access)
      c = { ...c, project: s.project, plan: s.plan || c.plan, tier: s.tier || c.tier, paid: s.paid || c.paid }
    }
    if (c.access !== before.access || c.project !== before.project) await providers.accounts.update(ID, account.key, { secret: JSON.stringify(c) })
    return { token: c.access, project: c.project, tier: c.tier, paid: c.paid, plan: c.plan }
  })
