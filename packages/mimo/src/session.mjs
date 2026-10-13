// Xiaomi MiMo: an account's session — signing on again, keeping it fresh, magpie's auth.refresh.
import { ID, LEAD_MS, RENEW_AFTER } from "./constants.mjs"
import { fromAuth, toAuth } from "./store.mjs"
import { Lapsed, session } from "./sso.mjs"

export function createSessions(client) {
  // renewals under way, one to an account: two accounts signing on at
  // once each keep their own session. renewed is the last session each
  // account got here, so magpie's auth.refresh handed a sign-in from
  // before it gives that one rather than signing on again.
  const renewing = new Map()
  const renewed = new Map()

  const save = async (auth) => {
    try {
      await client?.auth?.set?.({ path: { id: ID }, body: auth })
    } catch {}
  }

  // renew signs the account on again, once at a time: those who come
  // while it runs wait for it. keep saves the new session (the request
  // path); magpie's auth.refresh saves what it gives itself.
  const renew = (a, keep) => {
    const who = String(a.creds.userId ?? "")
    let r = renewing.get(who)
    if (!r) {
      r = (async () => {
        const s = await session(a.creds, a.creds.base)
        const issued = Date.now()
        const got = { creds: a.creds, cookies: s.cookies, expires: issued + RENEW_AFTER, renewed: true }
        renewed.set(who, got)
        if (keep) await save(toAuth(a.creds, s.cookies, issued))
        return got
      })().finally(() => {
        renewing.delete(who)
      })
      renewing.set(who, r)
    }
    return r
  }

  // fresh is the account with a live session, signed on again when it is
  // older than the app lets one get, or when force is set (the server
  // turned the last one away); renewed when it was signed on again, which
  // took the built-in's lapse mark off
  const fresh = async (getAuth, force) => {
    const a = fromAuth(await getAuth())
    if (!a) throw new Error("Xiaomi MiMo: not signed in")
    if (!force && Object.keys(a.cookies).length && Date.now() < a.expires) return a
    try {
      return await renew(a, true)
    } catch (e) {
      // a hiccup: the session in hand may still do
      if (!(e instanceof Lapsed) && !force && Object.keys(a.cookies).length) return a
      throw e
    }
  }

  // refresh is magpie's auth.refresh: the session signed on again
  // LEAD_MS before the app would, as the fields that changed (the Xiaomi
  // account in refresh stays as it is). A passToken Xiaomi no longer takes
  // is signIn "expired"; any other failure throws as it is.
  const refresh = async (auth) => {
    const a = fromAuth(auth)
    if (!a) return undefined
    const last = renewed.get(String(a.creds.userId ?? ""))
    // signed on again here already, the store not yet saying so
    if (last && last.expires > a.expires && Date.now() < last.expires - LEAD_MS) {
      return { access: JSON.stringify(last.cookies), expires: last.expires }
    }
    try {
      const s = await renew(a, false)
      return { access: JSON.stringify(s.cookies), expires: s.expires }
    } catch (e) {
      if (e instanceof Lapsed) throw Object.assign(new Error(e.message), { signIn: "expired" })
      throw e
    }
  }

  return { fresh, refresh }
}
