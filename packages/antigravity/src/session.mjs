// Antigravity: an account's tokens — refreshing them, and finding the project its requests are billed to.
import { EARLY_MS, ID, LEAD_MS } from "./constants.mjs"
import { EXPIRED, gone } from "./errors.mjs"
import { refreshToken, setup } from "./api.mjs"

/** Is there a sign-in to use: a Google account with a refresh token. */
export const hasSignIn = (auth) => auth?.type === "oauth" && typeof auth.refresh === "string" && auth.refresh.length > 0

/** Is a token good for a while yet. */
export const fresh = (c, early = EARLY_MS) => !!c.access && Number(c.expires) - Date.now() > early

// Google says a refresh token is no good this way; anything else (the network, Google being down) is no verdict on it
const TURNED_DOWN = new Set(["invalid_grant", "invalid_client", "unauthorized_client"])

/** A new access token for the sign-in c. Google's refresh tokens don't turn over, so the refresh token stays. */
export async function refresh(c) {
  if (!c.refresh) throw gone(EXPIRED)
  let t
  try {
    t = await refreshToken(c.refresh)
  } catch (e) {
    if (TURNED_DOWN.has(e?.code)) throw gone(`${EXPIRED} (Google: ${e.message})`)
    throw e
  }
  if (!t.access_token) throw new Error("Google sent back no access token")
  return { ...c, access: t.access_token, expires: Date.now() + (t.expires_in > 0 ? t.expires_in : 3600) * 1000 }
}

/**
 * Account holds the tokens in use, refreshing one when near its end or when Google turned it down; one refresh at a
 * time. What it learns (a renewed token, the project and plan) is kept here by refresh token, since magpie keeps what
 * auth.refresh gives but a request's refresh is not saved by anyone, and where the host lets it, saved too.
 */
export function account(client) {
  const held = new Map() // by refresh token
  let lock = Promise.resolve()
  const locked = (fn) => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }
  // the sign-in as stored, over what was learned since where that is newer
  const read = (auth) => {
    const c = { access: auth.access ?? "", refresh: auth.refresh, expires: Number(auth.expires) || 0, project: auth.project ?? "",
      plan: auth.plan ?? "", tier: auth.tier ?? "", paid: auth.paid ?? "" }
    const m = held.get(auth.refresh)
    if (!m) return c
    const newer = m.expires > c.expires ? m : c
    return { ...newer, project: c.project || m.project, plan: c.plan || m.plan, tier: c.tier || m.tier, paid: c.paid || m.paid }
  }
  const save = async (auth, c) => {
    if (!client?.auth?.set) return
    const rest = { ...auth }
    delete rest.type
    await client.auth.set({ path: { id: ID }, body: { ...rest, type: "oauth", access: c.access, refresh: c.refresh, expires: c.expires,
      project: c.project, plan: c.plan, tier: c.tier, paid: c.paid } }).catch(() => {})
  }
  // the project the account is billed to, asked of Code Assist (and the account set up there) the first time
  const withProject = async (c) => {
    if (c.project) return c
    const s = await setup(c.access)
    return { ...c, project: s.project, plan: s.plan || c.plan, tier: s.tier || c.tier, paid: s.paid || c.paid }
  }

  /**
   * What a request needs: { token, project, tier, paid }. `stale` is an access token Google just turned down: it is
   * refreshed unless someone else already has.
   */
  const creds = (auth, stale = "") =>
    locked(async () => {
      if (!hasSignIn(auth)) throw gone("this Antigravity account's sign-in is gone; add it again")
      let c = read(auth)
      const before = c
      if (!fresh(c) || (stale && c.access === stale)) c = await refresh(c)
      c = await withProject(c)
      held.set(auth.refresh, c)
      if (c.access !== before.access || c.project !== before.project) await save(auth, c)
      return { token: c.access, project: c.project, tier: c.tier, paid: c.paid, plan: c.plan }
    })

  // renew is auth.refresh's: renewed under the same lock as the requests' refresh, so the two never race. It saves
  // nothing — magpie saves what it gives — and gives only what changed.
  creds.renew = (auth) =>
    locked(async () => {
      if (!hasSignIn(auth)) return undefined
      let c = read(auth)
      if (!fresh(c, LEAD_MS)) c = await refresh(c)
      if (!c.project) c = await withProject(c).catch(() => c)
      held.set(auth.refresh, c)
      const out = { access: c.access, expires: c.expires }
      for (const k of ["project", "plan", "tier", "paid"]) if (c[k] && c[k] !== auth[k]) out[k] = c[k]
      return out
    })
  return creds
}
