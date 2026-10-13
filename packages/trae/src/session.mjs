// Trae: an account's sign-in as kept, and its tokens — renewing them, and keeping them fresh.
import { DAY, EARLY_MS } from "./constants.mjs"
import { newDeviceKey } from "./device.mjs"
import { boundExchange, exchange } from "./api.mjs"
import { Expired, expiredResponse } from "./errors.mjs"
import { authHostOf, traeHost } from "./sites.mjs"
import { jwtExp } from "./values.mjs"

// ---- the sign-in as kept ------------------------------------------------------

// The sign-in is kept as OpenCode keeps an OAuth one: access the
// Cloud-IDE-JWT, refresh the refresh token, expires the JWT's end; beside
// them the account, the client it was issued to and its device.
export function toAuth(s, site) {
  return {
    type: "oauth",
    access: s.token,
    refresh: s.refresh,
    expires: s.expires || jwtExp(s.token) || Date.now() + DAY,
    accountId: s.name || s.uid,
    uid: s.uid,
    clientId: s.clientId || site.clientId,
    deviceId: s.deviceId,
    machineId: s.machineId,
    ...(s.devicePrivateKey ? { devicePublicKey: s.devicePublicKey, devicePrivateKey: s.devicePrivateKey } : {}),
    // the model host the sign-in named, if it named one
    ...(site.modelHost(s.api) ? { api: s.api } : {}),
    ...(s.region ? { region: s.region } : {}),
    // the host the sign-in named, its own token host if it named one, and
    // what kind of account it is (an enterprise one's tenant), kept as given
    ...(traeHost(s.host) ? { host: traeHost(s.host) } : {}),
    ...(authHostOf(s.authHost, site) ? { authHost: authHostOf(s.authHost, site) } : {}),
    ...(s.account && Object.keys(s.account).length ? { account: s.account } : {}),
  }
}

export function fromAuth(auth, site) {
  if (auth?.type !== "oauth" || !auth.access) return null
  return {
    token: auth.access,
    refresh: auth.refresh ?? "",
    expires: Number(auth.expires) || 0,
    uid: String(auth.uid ?? ""),
    name: String(auth.accountId ?? ""),
    clientId: auth.clientId || site.clientId,
    deviceId: auth.deviceId || "",
    machineId: auth.machineId || "",
    devicePublicKey: auth.devicePublicKey || "",
    devicePrivateKey: auth.devicePrivateKey || "",
    api: auth.api || "",
    region: site.regionOf(auth),
    host: auth.host || "",
    authHost: authHostOf(auth.authHost, site),
    account: auth.account && typeof auth.account === "object" ? auth.account : {},
  }
}

// whoOf names the account a renewal is kept under, and a request is made as
export const whoOf = (a) => a.uid || a.name

// the sign-in header a request's answer carries
export const signInOf = (a) => (a.renewed ? "renewed" : "kept")

// ---- renewing ---------------------------------------------------------------------

// renewal renews an account's JWT: bound to its device where the site can
// (boundExchange), else, or when Trae turns that away, at /cloudide/… as
// before 0.2.3 (exchange). A device key made for the account goes with
// either, so the next renewal signs with the same one.
export async function renewal(a, site) {
  // the token host the sign-in named, else the site's
  const host = authHostOf(a.authHost, site) || site.hosts.auth
  if (!site.deviceExchange) return exchange(a.refresh, a.clientId, site, host)
  const keys = a.devicePrivateKey && a.devicePublicKey ? {} : newDeviceKey()
  try {
    return await boundExchange({ ...a, ...keys }, site, host)
  } catch {}
  return { ...(await exchange(a.refresh, a.clientId, site, host)), ...keys }
}

/**
 * The sessions of one plugin instance: which renewals are under way and what each account was last renewed to.
 * `fresh(getAuth)` is the account with a token that has a while to go; `refresh(auth)` is magpie's auth.refresh;
 * `save` stores a sign-in the way OpenCode does (`client.auth.set`).
 */
export function createSessions(site, client) {
  // renewals under way, one to a refresh token (Trae spends it once), and
  // the last each account got here, so a sign-in from before it is given
  // that one rather than spending the token again
  const renewing = new Map()
  const renewed = new Map()

  const save = async (auth) => {
    try {
      await client?.auth?.set?.({ path: { id: site.id }, body: auth })
    } catch {}
  }

  const renew = (a, keep) => {
    const key = a.refresh
    let r = renewing.get(key)
    if (!r) {
      r = (async () => {
        const x = await renewal(a, site)
        const got = { ...a, token: x.token, refresh: x.refresh, expires: x.expires || jwtExp(x.token) || Date.now() + DAY, clientId: x.clientId || a.clientId, renewed: true }
        if (x.devicePrivateKey) Object.assign(got, { devicePublicKey: x.devicePublicKey, devicePrivateKey: x.devicePrivateKey })
        renewed.set(whoOf(a), { was: a.refresh, got })
        if (keep) await save(toAuth(got, site))
        return got
      })().finally(() => renewing.delete(key))
      renewing.set(key, r)
    }
    return r
  }

  // newerHere: this account was renewed here since the sign-in a was read
  // from, to a token that runs longer
  const newerHere = (a) => {
    const last = renewed.get(whoOf(a))
    return !!last && last.was === a.refresh && last.got.token !== a.token && (last.got.expires || 0) > (a.expires || 0)
  }

  // fresh is the account with a token that has a while to go, renewed
  // when it hasn't
  const fresh = async (getAuth) => {
    let a = fromAuth(await getAuth(), site)
    if (!a) throw new Expired(`${site.realm}: not signed in`)
    // a renewal the sign-in doesn't hold yet. A device-bound one keeps the
    // refresh token, so the token tells it, and it is renewed in its turn
    if (newerHere(a)) a = { ...renewed.get(whoOf(a)).got, renewed: false }
    if (!a.expires || a.expires - Date.now() > EARLY_MS || !a.refresh) return a
    try {
      return await renew(a, true)
    } catch (e) {
      // a hiccup: the token in hand may still do
      if (!(e instanceof Expired) && a.expires > Date.now()) return a
      throw e
    }
  }

  // refresh is magpie's auth.refresh: the token renewed LEAD_MS before its
  // end, as the fields that changed
  const refresh = async (auth) => {
    const a = fromAuth(auth, site)
    if (!a || !a.refresh) return undefined
    const last = renewed.get(whoOf(a))
    // a device key made for the account is kept with the sign-in
    const out = (s) => ({
      access: s.token,
      refresh: s.refresh,
      expires: s.expires,
      ...(s.devicePrivateKey && s.devicePrivateKey !== a.devicePrivateKey ? { devicePublicKey: s.devicePublicKey, devicePrivateKey: s.devicePrivateKey } : {}),
    })
    if (newerHere(a)) return out(last.got)
    return out(await renew(a, false))
  }

  // the account, or the refusal the agent is given for one whose sign-in is gone; a0 names it for the message
  const freshOrRefusal = async (getAuth, a0) => {
    try {
      return { a: await fresh(getAuth) }
    } catch (e) {
      if (e instanceof Expired) return { refusal: expiredResponse(a0, e) }
      throw e
    }
  }

  return { fresh, refresh, freshOrRefusal }
}
