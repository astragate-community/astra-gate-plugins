// An account's tokens: how a sign-in is read, merged, refreshed and kept fresh.
import { API, PROVIDER, REFRESH_LEAD, RENEW_LEAD, RETRYABLE_GRACE, WORKOS_PREFIX } from "./constants.mjs"
import { Lapsed, clineApi } from "./api.mjs"
import { firstOf } from "./util.mjs"

// authOf reads a sign-in as magpie keeps it: OpenCode's type field, and what
// this plugin needs beside it to renew it later
export const authOf = (a) => ({
  type: a?.type === "api" ? "api" : "oauth",
  access: typeof a?.access === "string" ? a.access : "",
  refresh: typeof a?.refresh === "string" ? a.refresh : "",
  expires: Number(a?.expires) || 0,
  key: typeof a?.key === "string" ? a.key : "",
  uid: typeof a?.uid === "string" ? a.uid : "",
  email: typeof a?.email === "string" ? a.email : "",
  name: typeof a?.name === "string" ? a.name : "",
  accountId: typeof a?.accountId === "string" ? a.accountId : "",
})

// bearerOf is what an Authorization header carries: a signed-in account's
// access token with Cline's routing prefix, or the raw API key
export function bearerOf(a) {
  if (a?.type === "api") return a.key
  const access = typeof a?.access === "string" ? a.access : ""
  if (!access) return ""
  // the prefix is matched the way Cline's own client matches it, whatever case
  return access.toLowerCase().startsWith(WORKOS_PREFIX) ? access : WORKOS_PREFIX + access
}

// toMs is an expiry Cline sends as an ISO datetime; one it didn't send (or one
// that won't parse) is taken as an hour out rather than as "never"
export function toMs(v) {
  const t = typeof v === "string" ? Date.parse(v) : Number(v)
  if (Number.isFinite(t) && t > Date.now()) return t
  return Date.now() + 60 * 60 * 1000
}

// parseAuth reads Cline's token answer ({accessToken, refreshToken, expiresAt,
// userInfo}) into what this plugin keeps, with a refresh to fall back on when
// the answer didn't rotate it
export function parseAuth(data, fallbackRefresh = "") {
  const access = typeof data?.accessToken === "string" ? data.accessToken : ""
  if (!access) return { error: "Cline sent back no access token" }
  const refresh = firstOf(data?.refreshToken, fallbackRefresh)
  if (!refresh) return { error: "Cline sent back no refresh token" }
  const ui = data?.userInfo && typeof data.userInfo === "object" ? data.userInfo : {}
  const uid = firstOf(ui.clineUserId, ui.subject)
  const email = firstOf(ui.email)
  return {
    access,
    refresh,
    expires: toMs(data?.expiresAt),
    uid,
    email,
    name: firstOf(ui.name),
    accountId: firstOf(email, uid),
  }
}

// refresh trades the refresh token for a new pair; Cline rotates it, so the
// caller saves what comes back. A dead token is refused as 400 invalid_grant
// (WorkOS's wording rides in the body), not 401 — that refusal is the sign-in
// gone, anything else is worth a retry later.
export async function refresh(a) {
  if (!a.refresh) throw new Lapsed("Cline's refresh token is gone; sign in to Cline again")
  const data = await clineApi(`${API}/auth/refresh`, {
    method: "POST",
    body: { refreshToken: a.refresh, grantType: "refresh_token" },
    lapsed: (status, text) => [400, 401, 403].includes(status) && /invalid|expired|revoked|unauthorized/i.test(text),
  })
  const p = parseAuth(data, a.refresh)
  if (p.error) throw new Error(`Cline token refresh: ${p.error}`)
  return p
}

// the credential a request, a model list or a usage read works with: the account's pair and the bearer it sends
const credOf = (a, renewed = false) => ({ ...a, bearer: bearerOf(a), renewed })

/**
 * The state one plugin instance keeps for the accounts it serves, and the two ways a token is kept fresh:
 * `fresh(getAuth)` before a request (OpenCode's path, and magpie's) and `renew(auth)`, magpie's own
 * `auth.refresh` hook. Both take the same lock and the same held pairs, so the two never spend one refresh
 * token twice. `client` is where magpie keeps the sign-in (client.auth.set).
 */
export function createSession(client) {
  // the rotated pair, kept in memory beside what magpie saved: a save through
  // client.auth.set may fail, and the next request must not spend a refresh
  // token that was already spent (kiro's held). Every token this run has spent
  // is kept, not only the last one — a store that failed once usually goes on
  // failing, so getAuth keeps handing back the first of them — and each token
  // is kept against the pair its own rotation chain reached, since one plugin
  // instance serves every account of the provider at once: one newest pair
  // shared by all of them would send an account on another account's token
  const held = new Map() // a spent refresh token → its chain's newest pair

  // remember saves a refreshed pair where magpie keeps it
  const remember = async (next) => {
    try {
      await client?.auth?.set?.({
        path: { id: PROVIDER },
        body: {
          type: "oauth",
          access: next.access,
          refresh: next.refresh,
          expires: next.expires,
          uid: next.uid ?? "",
          email: next.email ?? "",
          name: next.name ?? "",
          accountId: next.accountId ?? "",
        },
      })
    } catch {}
  }

  // refreshes are serialized: the refresh token is single-use, and two
  // requests renewing at once spend one and lose the other
  let lock = Promise.resolve()
  const locked = (fn) => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }

  // latest is the account with the newest pair this run rotated for it: that
  // pair is newer than the one getAuth still hands back, so it is used rather
  // than re-spending a spent token
  const latest = (a) => {
    const h = held.get(a.refresh)
    return h ? { held: true, r: { ...a, access: h.access, refresh: h.refresh, expires: h.expires } } : { held: false, r: a }
  }

  // spend trades r's refresh token for a new pair and holds it, whatever a
  // save then does, against the token it spent and the one getAuth handed
  // back (a's): the next request offering either of them finds this chain's
  // newest. Called under the lock only.
  const spend = async (a, r) => {
    const p = await refresh(r)
    const next = { ...r, access: p.access, refresh: p.refresh, expires: p.expires, uid: p.uid || r.uid, email: p.email || r.email, name: p.name || r.name, accountId: r.accountId || p.accountId }
    const chain = held.get(a.refresh) ?? {}
    Object.assign(chain, { access: next.access, refresh: next.refresh, expires: next.expires })
    held.set(a.refresh, chain)
    held.set(r.refresh, chain)
    return next
  }

  // fresh is the account with a token still good: one near its end is
  // renewed, and the rotated pair saved back. A transient refresh failure
  // keeps the token that is still good, as Cline's own client does; only a
  // token that has actually expired is the sign-in gone. `renewed` on what
  // it returns says this call renewed the token: the sign-in mark comes off
  // on the renewed token, whatever the request then met.
  const fresh = (getAuth) =>
    locked(async () => {
      const a = authOf(await getAuth())
      if (a.type === "api") {
        if (!a.key) throw new Lapsed("Cline: no API key; add one to the account")
        return { bearer: a.key, renewed: false, accountId: a.accountId }
      }
      if (!a.access && !a.refresh) throw new Lapsed("Cline: not signed in")
      if (a.access && a.expires - Date.now() > REFRESH_LEAD) return credOf(a)
      const { r } = latest(a)
      if (r.access && r.expires - Date.now() > REFRESH_LEAD) return credOf(r)
      if (!r.refresh) throw new Lapsed("Cline's access token has expired and there is no refresh token; sign in to Cline again")
      let next
      try {
        next = await spend(a, r)
      } catch (e) {
        // a token that is still good rides on through a refresh that
        // failed for a while; an expired one is the sign-in gone
        if (!e?.expired && r.access && r.expires - Date.now() > RETRYABLE_GRACE) return credOf(r)
        throw e
      }
      await remember(next)
      return credOf(next, true)
    })

  // renew is magpie's auth.refresh: it renews the sign-in RENEW_LEAD before
  // its end, once for the account, before its requests, models and usage ask
  // for it; the check in fresh before each request stays for OpenCode, which
  // doesn't call this. magpie saves what this gives (it is merged over the
  // sign-in): only what changed comes back, and remember isn't called here.
  const renew = (auth) =>
    locked(async () => {
      const a = authOf(auth)
      // an API key, or a sign-in with nothing to renew with
      if (auth?.type !== "oauth" || !a.refresh) return undefined
      // renewed here already (a request's refresh), the store not
      // yet saying so: that pair, not another spend
      const { held: had, r } = latest(a)
      if (had && r.access && r.expires - Date.now() > RENEW_LEAD) return { access: r.access, refresh: r.refresh, expires: r.expires }
      let next
      try {
        next = await spend(a, r)
      } catch (e) {
        // a refused refresh is the sign-in gone; anything else is
        // retried by magpie, the token in hand riding on meanwhile
        if (e?.expired) throw Object.assign(new Error(String(e.message ?? e).replace(/^Cline: /, "")), { signIn: "expired" })
        throw e
      }
      const out = { access: next.access, refresh: next.refresh, expires: next.expires }
      for (const k of ["uid", "email", "name", "accountId"]) if (next[k] && next[k] !== a[k]) out[k] = next[k]
      return out
    })

  return { fresh, renew }
}
