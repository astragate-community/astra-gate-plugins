// Qoder: an account's tokens — refreshing them, remembering what a spent refresh token gave, and keeping them fresh.
import { DAY, KEEP_SPENT_MS, REFRESH_LEAD, RENEW_LEAD } from "./constants.mjs"
import { openapi } from "./api.mjs"
import { SignInGone, expiredError } from "./errors.mjs"
import { siteOf } from "./sites.mjs"
import { blank } from "./util.mjs"

// expiresAt is when a job token Qoder gave with expires_in (milliseconds)
// runs out; a day when it said none.
export const expiresAt = (jt) => Date.now() + (jt.expires_in > 0 ? jt.expires_in : DAY)

// deviceExpiry is when a device token used for chat runs out: its
// expires_at (a date) or expires_in (seconds), as Qoder's CLI reads it; a
// day when it said neither.
export function deviceExpiry(dt) {
  const at = Date.parse(String(dt?.expires_at ?? "").trim())
  if (!isNaN(at)) return at
  if (dt?.expires_in > 0) return Date.now() + dt.expires_in * 1000
  return Date.now() + DAY
}

const lapsed = (site) => new SignInGone(`${site.name}: the sign-in lapsed; sign in again`)

// refreshJob trades the job token's refresh token for a new pair; the old
// one is spent.
export async function refreshJob(site, refresh, user) {
  if (blank(refresh)) throw lapsed(site)
  const r = await openapi(site, "/api/v1/jobToken/refresh", { method: "POST", body: { refresh_token: refresh } })
  if (r.status === 401 || r.status === 403)
    throw new SignInGone(`${user}'s ${site.name} sign-in has expired — sign in again (qoder job token refresh: status ${r.status})`, true)
  if (r.status !== 200) throw new Error(`qoder job token refresh: status ${r.status}`)
  if (blank(r.json?.token) || blank(r.json?.refresh_token)) throw new Error("qoder job token refresh: incomplete token pair")
  return r.json
}

// refreshDevice trades the device refresh token for a new pair; it rotates
// too, so the caller saves it.
export async function refreshDevice(site, refresh, chat = false) {
  if (blank(refresh)) {
    if (chat) throw lapsed(site)
    throw new Error("qoder device token refresh: missing refresh token; sign in again")
  }
  let r
  try {
    r = await openapi(site, "/api/v1/deviceToken/refresh", { method: "POST", body: { refresh_token: refresh } })
  } catch (e) {
    throw new Error(`qoder device token refresh: request failed: ${e?.message ?? e}`)
  }
  if (r.status !== 200) {
    const err = `qoder device token refresh: upstream HTTP ${r.status}`
    if (r.status === 401 || r.status === 403) {
      // a device token that is the chat token too: refused, the sign-in is gone
      if (chat) throw new SignInGone(`${site.name} sign-in has expired — sign in again (${err})`, true)
      // otherwise it serves only the account pages (usage); chat runs on
      // the job token, so a refused one doesn't lapse the account
      throw new Error(`${site.name} usage is unavailable: ${site.name} refused the account-page sign-in (chat still works) — sign in again to see usage (${err})`)
    }
    throw new Error(err)
  }
  const token = r.json?.token || r.json?.device_token || ""
  if (blank(token) || blank(r.json?.refresh_token)) throw new Error("qoder device token refresh: incomplete token pair")
  return { token, refresh: r.json.refresh_token, expires: deviceExpiry(r.json) }
}

// devicePair is what a refreshed device token gives an account whose device token is its chat token too:
// both pairs being the one pair.
const devicePair = (dt) => ({ access: dt.token, refresh: dt.refresh, expires: dt.expires, deviceToken: dt.token, deviceRefresh: dt.refresh })

// changed is the fields of b that differ from a's: what auth.refresh gives.
export function changed(a, b) {
  const out = {}
  for (const k of ["access", "refresh", "expires", "deviceToken", "deviceRefresh"]) if (b[k] !== a[k]) out[k] = b[k]
  return out
}

// A public and a VPC account can name the same uid but have different
// catalogs and sessions: each deployment's account is told apart.
export const listingKey = (cred) => `${cred.vpc ?? ""}\0${cred.uid}`

/**
 * One plugin's view of its accounts' sign-ins. All the state that has to be shared between a request, the usage
 * read and magpie's auth.refresh lives here: the lock, what spent refresh tokens gave, which accounts were
 * renewed. `client` is OpenCode's/magpie's client, whose auth.set saves an account.
 */
export function createSession(site, client) {
  // serializes checking, rotating and saving tokens: a refresh token is
  // spent once, so two refreshes would spend it twice
  let lock = Promise.resolve()
  const locked = (fn) => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }
  // spent is what each refresh token this process spent gave, by that
  // token: the chat pair it renewed. magpie saves what auth.refresh gives
  // only once the hook has returned, and a request may read the account in
  // between, or the hook be handed the account as it was before a request
  // renewed it: either follows spent rather than spending the token again.
  const spent = new Map()
  const latest = (a) => {
    for (let i = 0; i < 16 && a?.refresh; i++) {
      const s = spent.get(a.refresh)
      if (!s) break
      a = { ...a, ...s.got }
    }
    return a
  }
  const spend = (refresh, got) => {
    const now = Date.now()
    for (const [k, v] of spent) if (now - v.at > KEEP_SPENT_MS) spent.delete(k)
    spent.set(refresh, { got, at: now })
    return got
  }
  // renew spends a's chat refresh token, under the lock: the fields it
  // changes, recorded in spent.
  const renew = async (a) => {
    const s = siteOf(site, a)
    if (a.deviceChat) {
      // the device token is the chat token: renewed as a device token
      return spend(a.refresh, devicePair(await refreshDevice(s, a.refresh, true)))
    }
    const jt = await refreshJob(s, a.refresh, a.accountId || a.email || a.uid)
    return spend(a.refresh, { access: jt.token, refresh: jt.refresh_token, expires: expiresAt(jt) })
  }
  const save = (account) => client.auth.set({ path: { id: site.id }, body: account })

  // the accounts fresh renewed: the built-in took the lapse mark off on a
  // renewed job token (qoderPersist), whatever the request then met
  const renewals = new WeakSet()
  // the accounts the models hook renewed: that hook has no way to say so
  // and still answer the list, so the account's next usage read or answer
  // says "renewed" for it
  const unsaid = new Set()
  const renewed = (cred) => {
    const was = unsaid.delete(listingKey(cred))
    return renewals.has(cred) || was
  }
  // modelsRenewed notes that the models hook is the one that renewed cred.
  const modelsRenewed = (cred) => {
    if (renewals.has(cred)) unsaid.add(listingKey(cred))
  }

  // fresh is the account with a live job token, refreshed and saved near
  // its end.
  const fresh = (getAuth) =>
    locked(async () => {
      const stored = await getAuth()
      if (stored?.type !== "oauth" || !stored.access || !stored.uid) throw new SignInGone(`${site.name}: not signed in`)
      siteOf(site, stored) // a VPC instance on record that names none is no sign-in
      // renewed already (by magpie's auth.refresh), the store not yet saying so
      const a = latest(stored)
      if (a.expires - Date.now() > REFRESH_LEAD) return a
      const next = { ...a, ...(await renew(a)) }
      await save(next)
      renewals.add(next)
      return next
    })

  // deviceToken is a device token newer than the one Qoder just refused:
  // the one saved since, else a rotated one, saved.
  const deviceToken = (getAuth, attempted) =>
    locked(async () => {
      const a = latest(await getAuth())
      if (a?.deviceToken !== attempted) return a?.deviceToken
      const dt = await refreshDevice(siteOf(site, a), a.deviceRefresh, !!a.deviceChat)
      const next = { ...a, deviceToken: dt.token, deviceRefresh: dt.refresh }
      // the pair it spent was the chat pair too
      if (a.deviceChat) Object.assign(next, spend(a.refresh, devicePair(dt)))
      await save(next)
      return dt.token
    })

  // refresh is the auth.refresh hook: magpie renews the chat token RENEW_LEAD before its end.
  async function refresh(auth) {
    if (auth?.type !== "oauth" || !auth.access || !auth.uid || blank(auth.refresh)) return undefined
    return locked(async () => {
      // a request renewed it meanwhile (or magpie hasn't saved this
      // hook's last answer): what that gave, not a second refresh
      const a = latest(auth)
      if (a.access !== auth.access && a.expires - Date.now() > RENEW_LEAD) return changed(auth, a)
      try {
        // magpie saves what this gives
        return changed(auth, { ...a, ...(await renew(a)) })
      } catch (e) {
        if (e?.expired) throw expiredError(e)
        throw e
      }
    })
  }

  return { fresh, deviceToken, refresh, renewed, modelsRenewed }
}
