// WorkBuddy: an account's tokens — merging, refreshing and keeping them fresh.
import { EARLY_MS, KEEP_RENEWED_MS } from "./constants.mjs"
import { call, domainOf, enterpriseHeaders } from "./api.mjs"
import { notDesktop, readDesktop } from "./signin.mjs"

// merge takes a token WorkBuddy gave (sign-in or refresh) into the
// stored sign-in, times given as at-ms or in-seconds.
export function merge(a, got) {
  const now = Date.now()
  const out = { ...a, access: got.accessToken }
  if (got.refreshToken) out.refresh = got.refreshToken
  if (got.domain) out.domain = got.domain
  if (got.tokenType) out.tokenType = got.tokenType
  if (got.expiresAt > 0) out.expires = got.expiresAt
  else if (got.expiresIn > 0) out.expires = now + got.expiresIn * 1000
  if (got.refreshExpiresAt > 0) out.refreshExpiresAt = got.refreshExpiresAt
  else if (got.refreshExpiresIn > 0) out.refreshExpiresAt = now + got.refreshExpiresIn * 1000
  return out
}

function stale(a) {
  return !!a.expires && Date.now() >= a.expires - EARLY_MS
}

// renewing is each refresh under way, by site and the refresh token it
// spends; renewed is what each gave, kept a minute so one that read the
// old refresh token after it was spent (magpie's auth.refresh, a request)
// takes that rather than spending it again.
const renewing = new Map()
const renewed = new Map()

function refreshable(a) {
  return !!a.refresh && !(a.refreshExpiresAt && Date.now() >= a.refreshExpiresAt)
}

// renew spends a's refresh token, once: those who come while it runs, or
// within KEEP_RENEWED_MS of it, get what it gave. save keeps the result.
function renew(site, a, save) {
  const key = site.id + "\n" + a.refresh
  const done = renewed.get(key)
  if (done && Date.now() - done.at < KEEP_RENEWED_MS) return Promise.resolve(merged(a, done.next))
  let r = renewing.get(key)
  if (!r) {
    r = (async () => {
      const got = await call(site, "POST", "/v2/plugin/auth/token/refresh", {
        "X-Refresh-Token": a.refresh,
        "X-Auth-Refresh-Source": "plugin",
        "X-Domain": domainOf(site, a),
        ...enterpriseHeaders(a),
      }, {})
      if (!got?.accessToken) throw Object.assign(new Error("WorkBuddy gave no refreshed token"), { bare: true })
      const next = merge(a, got)
      renewed.set(key, { next, at: Date.now() })
      await save?.(next)
      return next
    })().finally(() => renewing.delete(key))
    renewing.set(key, r)
  }
  return r.then((next) => merged(a, next))
}

// merged is a with the tokens another's refresh gave over it.
function merged(a, next) {
  const out = { ...a }
  for (const k of TOKEN_FIELDS) if (k in next) out[k] = next[k]
  return out
}
const TOKEN_FIELDS = ["access", "refresh", "expires", "refreshExpiresAt", "domain", "tokenType"]

// fresh is the sign-in with an access token that isn't about to end:
// refreshed (and saved) when it is. A refresh that fails, or a refresh
// token that has ended, leaves the access token there is. Its failures
// are worded as the built-in's (wbFresh), "WorkBuddy" on both sites.
async function fresh(site, client, a) {
  if (!stale(a)) return a
  if (!refreshable(a)) {
    if (a.access) return a
    throw new Error("this WorkBuddy account is signed out; sign in again")
  }
  try {
    return await renew(site, a, async (next) => {
      try {
        await client?.auth?.set?.({ path: { id: site.id }, body: next })
      } catch {}
    })
  } catch (e) {
    if (a.access) return a
    if (e?.bare) throw e
    throw new Error(`WorkBuddy token refresh: ${e?.said ?? e?.message ?? e}`)
  }
}

// refreshed is what magpie's auth.refresh gives for a browser sign-in:
// the fields a refresh changed, nothing when there's nothing to renew.
// magpie saves them itself.
export async function refreshed(site, auth) {
  if (auth?.type !== "oauth" || auth.source === "desktop" || !auth.access || !auth.refresh) return undefined
  // a refresh token that has ended is said plainly, never as signIn
  // "expired": the built-in never marked a WorkBuddy account
  if (!refreshable(auth)) throw new Error("this WorkBuddy account is signed out; sign in again")
  let next
  try {
    next = await renew(site, auth)
  } catch (e) {
    if (e?.bare) throw e
    throw new Error(`WorkBuddy token refresh: ${e?.said ?? e?.message ?? e}`)
  }
  const out = {}
  for (const k of TOKEN_FIELDS) if (k in next && next[k] !== auth[k]) out[k] = next[k]
  return Object.keys(out).length ? out : undefined
}

// desktopHeld is what a desktop sign-in was renewed to here, by site and
// account: kept in memory only, never written where the app keeps it.
const desktopHeld = new Map()

// current is the sign-in a stored auth names, fresh: WorkBuddy desktop's,
// read where it keeps it, or one kept here.
export async function current(site, client, auth) {
  if (auth?.source !== "desktop") return fresh(site, client, auth)
  const d = readDesktop(site)
  if (!d) throw new Error(notDesktop(site))
  const k = site.id + "|" + d.uid
  const h = desktopHeld.get(k)
  const a = await fresh(site, null, h && h.expires >= d.expires ? h : d)
  desktopHeld.set(k, a)
  return a
}