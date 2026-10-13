// Kiro: an account's tokens — reading what its owner holds, refreshing, and keeping fresh.
import { DESKTOP_UA, EARLY_MS, ID, LEAD_MS, isBuilderID, oidc, refreshURL } from "./constants.mjs"
import { EXPIRED, EXPIRED_CLI, gone, statusLine } from "./errors.mjs"
import { profileOf, regionOf, tokenType } from "./api.mjs"
import { kiroExecutable, readCLI, readIDE, runKiroRefresh, saveBack } from "./stores.mjs"

export const fresh = (c, early = EARLY_MS) => c.method === "apikey" || !c.expires || c.expires - Date.now() > early

// post is a token refresh's request.
async function post(url, contentType, body, headers = {}) {
  let res
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": contentType, Accept: "application/json", ...headers }, body,
      signal: AbortSignal.timeout(30_000) })
  } catch (e) {
    throw new Error("refreshing Kiro's sign-in: " + e.message)
  }
  const text = await res.text()
  if (!res.ok) {
    if ([400, 401, 403].includes(res.status)) throw gone(EXPIRED_CLI)
    throw new Error(`refreshing Kiro's sign-in: ${statusLine(res.status)}`) // Go's res.Status
  }
  return JSON.parse(text)
}

// exchange trades a sign-in's refresh token at its own token endpoint and
// gives back what came, in one shape: { access, refresh, expiresIn }.
async function exchange(c) {
  switch (c.method) {
    case "social": {
      const r = await post(refreshURL(c.region), "application/json", JSON.stringify({ refreshToken: c.refresh }), { "User-Agent": DESKTOP_UA })
      if (r.profileArn) c.profile = r.profileArn
      return { access: r.accessToken, refresh: r.refreshToken, expiresIn: r.expiresIn }
    }
    case "idc": {
      const r = await post(oidc(c.region) + "/token", "application/json",
        JSON.stringify({ clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refresh, grantType: "refresh_token" }))
      return { access: r.accessToken, refresh: r.refreshToken, expiresIn: r.expiresIn }
    }
    case "external-idp": {
      if (!c.tokenURL) throw gone(EXPIRED + " with `kiro-cli login`")
      const form = new URLSearchParams({ grant_type: "refresh_token", client_id: c.clientId ?? "", refresh_token: c.refresh })
      const r = await post(c.tokenURL, "application/x-www-form-urlencoded", form.toString())
      return { access: r.access_token, refresh: r.refresh_token, expiresIn: r.expires_in }
    }
    default:
      throw gone("Kiro's sign-in has expired")
  }
}

// refresh refreshes a sign-in's token the way its owner would: kiro-cli's
// by kiro-cli first.
export async function refresh(c) {
  if (c.dbKey) {
    const bin = kiroExecutable()
    if (bin) {
      await runKiroRefresh(bin)
      const n = await readCLI()
      if (n && n.dbKey === c.dbKey && n.access !== c.access && fresh(n)) return n
    }
  }
  if (!c.refresh) throw gone(EXPIRED_CLI)
  const out = await exchange(c)
  if (!out.access) throw gone(EXPIRED_CLI)
  const n = { ...c, access: out.access, expires: Date.now() + (out.expiresIn > 0 ? out.expiresIn : 3600) * 1000 }
  if (out.refresh) n.refresh = out.refresh
  await saveBack(n)
  return n
}

/** Is there a sign-in to use: an API key, or an OAuth account. */
export const hasSignIn = (auth) => (auth?.type === "api" && !!auth.key) || auth?.type === "oauth"

// credOf is the sign-in a stored auth names: a key, one signed in here, or
// kiro-cli's or the IDE's, read where they keep it now.
export async function credOf(auth) {
  if (auth?.type === "api" && auth.key) return { access: auth.key, method: "apikey", region: "us-east-1" }
  if (auth?.type !== "oauth") return null
  if (auth.source === "kiro-cli") return readCLI()
  if (auth.source === "kiro-ide") return readIDE()
  if (auth.source === "kiro") return (await readCLI()) ?? (await readIDE())
  if (!auth.access) return null
  return { access: auth.access, refresh: auth.refresh ?? "", expires: auth.expires ?? 0, method: auth.method || "social",
    region: auth.region || "us-east-1", profile: auth.profileArn ?? "", clientId: auth.clientId ?? "", clientSecret: auth.clientSecret ?? "",
    builderID: isBuilderID(auth.loginProvider), own: true }
}

// Account holds the credentials in use, refreshing them when near their
// end or when Kiro turned one down; one refresh at a time, as a refresh
// may replace the refresh token.
//
// after is what each refresh gave, by the access token it replaced: a
// sign-in read with that token (its save failed, or magpie hasn't yet
// saved what auth.refresh gave) goes on with the newer one rather than
// spending the replaced refresh token again.
export function account(client) {
  let held = null // { id, c }
  const after = new Map()
  const newest = (c) => {
    for (let i = 0; i < 16 && after.has(c.access); i++) c = { ...after.get(c.access) }
    return c
  }
  const renewed = (c, n) => {
    after.set(c.access, n)
    if (after.size > 16) after.delete(after.keys().next().value)
    return n
  }
  let lock = Promise.resolve()
  const locked = (fn) => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }
  const save = async (auth, c) => {
    if (!c.own || !client?.auth?.set) return
    const rest = { ...auth }
    delete rest.type // replaced by "oauth" below
    await client.auth.set({ path: { id: ID }, body: { ...rest, type: "oauth", access: c.access, refresh: c.refresh, expires: c.expires,
      profileArn: c.profile, region: c.region } }).catch(() => {})
  }
  const creds = (auth, stale = false) =>
    locked(async () => {
      const id = auth?.type === "api" ? "key:" + auth.key : "oauth:" + (auth?.source ?? "own")
      // what its owner holds now: it may have refreshed it, signed out, or
      // signed in to another account since
      let read = await credOf(auth)
      if (!read) {
        held = null
        throw gone(
          auth?.source
            ? "Kiro isn't signed in; add the Kiro subscription in magpie, sign in with `kiro-cli login` or the Kiro IDE, or save a Kiro API key on the provider"
            : "this Kiro account's sign-in is gone; add it again in magpie",
        )
      }
      read = newest(read)
      let c = held?.id === id ? held.c : null
      if (!c || read.access !== c.access || !fresh(c) || stale) {
        if (!read.profile && c && read.access === c.access) read.profile = c.profile
        if (stale && c && read.access !== c.access && fresh(read)) stale = false // the owner refreshed it already
        c = read
        if (!fresh(c) || stale) {
          if (c.method === "apikey") throw gone("Kiro turned down the API key saved on the provider")
          c = renewed(c, await refresh(c))
          await save(auth, c)
        }
      }
      if (!c.profile) {
        c.profile = await profileOf(c)
        if (!auth?.profileArn) await save(auth, c)
      }
      held = { id, c }
      return { token: c.access, tokenType: tokenType(c), profile: c.profile, region: regionOf(c.profile, c.region) }
    })
  // renew is auth.refresh's: a sign-in kept here (not kiro-cli's or the
  // IDE's, which their owners keep) renewed under the same lock as the
  // requests' refresh, so the two never spend one refresh token. It saves
  // nothing — magpie saves what it gives — and gives only what changed.
  creds.renew = (auth) =>
    locked(async () => {
      const read = await credOf(auth)
      if (!read?.own || !read.refresh) return undefined
      let c = newest(read)
      // renewed here already (a request's refresh, or this hook's whose
      // result magpie hasn't saved yet), the store not yet saying so
      if (c.access === read.access || !fresh(c, LEAD_MS)) c = renewed(c, await refresh(c))
      held = { id: "oauth:own", c }
      const out = { access: c.access, expires: c.expires }
      if (c.refresh !== auth.refresh) out.refresh = c.refresh
      if (c.profile && c.profile !== auth.profileArn) out.profileArn = c.profile
      return out
    })
  return creds
}
