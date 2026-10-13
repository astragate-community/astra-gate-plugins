// Factory: an account's tokens, renewed and kept in the right org.
import { ASK_AGAIN, MAGPIE_LEAD, PROVIDER, REFRESH_LEAD } from "./constants.mjs"
import { FactoryStatus, lapsed, orgRefused, refused } from "./errors.mjs"
import { firstOrg, renew, whoami } from "./api.mjs"
import { expiry } from "./jwt.mjs"
import { isKey, keyAccount } from "./keys.mjs"

/** Puts the access token (and its expiry) of a WorkOS answer on c; the refresh token too when it rotated. */
export function applyTokens(c, t) {
  c.access = t.access_token
  c.expires = expiry(t.access_token)
  if (t.refresh_token) c.refresh = t.refresh_token
}

/** Keeps where Factory serves the org whoami names: its region and its own host, if any. */
export function adoptPlace(c, who) {
  c.region = who.region ?? ""
  c.premBaseHost = who.premBaseHostV2 ?? ""
}

/** Fills in whose account it is, from whoami, where the sign-in didn't say. */
export function adoptIdentity(c, who) {
  c.email ||= who.email ?? ""
  c.userId ||= who.userId ?? ""
}

// reconcile asks whoami, as droid does for each token it holds, and keeps the
// org, region and host it names: true when any changed. An active org whoami
// refuses is left off and whoami asked again without it.
export async function reconcile(c) {
  const signal = AbortSignal.timeout(10_000)
  let who
  try {
    who = await whoami(c, signal)
  } catch (e) {
    if (!(c.activeOrganizationId && e instanceof FactoryStatus && e.code === 403)) return false
    try {
      who = await whoami({ ...c, activeOrganizationId: "" }, signal)
    } catch {
      return false
    }
  }
  if (!who?.orgId) return false
  const changed = c.activeOrganizationId !== who.orgId || (c.region ?? "") !== (who.region ?? "") || (c.premBaseHost ?? "") !== (who.premBaseHostV2 ?? "")
  c.activeOrganizationId = who.orgId
  adoptPlace(c, who)
  return changed
}

// renewal is what of c magpie keeps over the stored sign-in
function renewal(c) {
  const out = { access: c.access, refresh: c.refresh, expires: c.expires }
  for (const k of ["orgId", "activeOrganizationId", "region", "premBaseHost"]) if (typeof c[k] === "string") out[k] = c[k]
  return out
}

/**
 * The accounts one plugin instance serves, with the state they share: the lock tokens are rotated under, what
 * each rotation gave, and when whoami was last asked. Returns `account(getAuth)` ({ fresh, mendOrg }) and the
 * `refresh(auth)` magpie calls ahead of an expiry.
 */
export function createSession(client) {
  // serializes checking, rotating and saving tokens: WorkOS rotates the
  // refresh token, so two refreshes would spend it twice
  let lock = Promise.resolve()
  const locked = (fn) => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }
  // renewed is what each refresh this process ran gave, by the refresh
  // token it spent: a sign-in still holding that one (magpie not yet
  // saving what auth.refresh gave, or a save that failed) goes on with
  // the new tokens rather than spending the old one again
  const renewed = new Map()
  const took = (spent, c) => {
    for (const [k, v] of renewed) if (v.expires > 0 && Date.now() >= v.expires) renewed.delete(k)
    renewed.set(spent, { access: c.access, refresh: c.refresh, expires: c.expires, orgId: c.orgId, activeOrganizationId: c.activeOrganizationId, region: c.region, premBaseHost: c.premBaseHost })
  }
  // latest is c with the newest tokens this process got for it
  const latest = (c) => {
    for (let i = 0; i < 16 && c.refresh; i++) {
      const got = renewed.get(c.refresh)
      if (!got || got.access === c.access || (c.expires > 0 && got.expires > 0 && got.expires <= c.expires)) break
      c = { ...c, ...got }
    }
    return c
  }
  // when each account last asked whoami for its org, so one whoami can't
  // answer doesn't ask before every request, nor hold back the others
  const asked = new Map()
  const askedKey = (c) => c.accountId || c.refresh || c.access || ""
  const askedOf = (c) => asked.get(askedKey(c)) ?? 0
  const ask = (c) => asked.set(askedKey(c), Date.now())

  const save = async (c) => {
    // type last, whatever the account (a key's, say) carried
    const body = { ...c }
    delete body.type
    body.type = "oauth"
    await client.auth.set({ path: { id: PROVIDER }, body })
  }

  // rotate spends c's refresh token for a new pair, as droid does for each
  // new token keeping the org whoami names, and remembers what it gave
  const rotate = async (c, t, spent) => {
    applyTokens(c, t)
    await reconcile(c)
    ask(c)
    took(spent, c)
  }

  // account is the account getAuth reads, with what keeps its token live
  // and its org right.
  const account = (getAuth) => {
    const current = async () => {
      const a = await getAuth()
      if (isKey(a)) return keyAccount(a)
      if (a?.type !== "oauth" || !a.access) throw new Error("Factory: not signed in")
      return { ...a }
    }

    // keyed is a key account with where Factory serves its org: whoami,
    // asked with the key and no org (droid's st() is null for a key), as
    // droid's yP checks a key before it is used, and as the built-in asks
    // it when the key is added. What it names is kept in the key's
    // metadata, so magpie shows whose the key is; a whoami that fails is
    // asked again ASK_AGAIN later, the request going on meanwhile.
    const keyed = async (c) => {
      if (c.whoKnown || Date.now() - askedOf(c) < ASK_AGAIN) return c
      ask(c)
      let who
      try {
        who = await whoami({ ...c, activeOrganizationId: "" })
      } catch {
        return c
      }
      adoptPlace(c, who)
      adoptIdentity(c, who)
      c.whoKnown = true
      const a = await getAuth()
      if (isKey(a) && a.key === c.access) {
        const metadata = { ...(a.metadata ?? {}), email: c.email, userId: c.userId, region: c.region, premBaseHost: c.premBaseHost }
        await client.auth.set({ path: { id: PROVIDER }, body: { ...a, metadata } }).catch(() => {})
      }
      return c
    }

    // orgOf fills in the active org when there is none: droid asks
    // whoami as soon as it holds a token and sends the orgId it answers
    // as X-Factory-Org-Id on every request after.
    const orgOf = async (c) => {
      if (c.activeOrganizationId || Date.now() - askedOf(c) < ASK_AGAIN) return c
      ask(c)
      if (await reconcile(c)) await save(c)
      return c
    }

    // fresh is a live token, renewed near its end; onRenew is told when
    // it was, the built-in's clearing of the account's lapse.
    const fresh = (onRenew) =>
      locked(async () => {
        const c = latest(await current())
        if (c.key) return keyed(c) // an API key: nothing to renew, and no org with it
        if ((c.expires > 0 && Date.now() < c.expires - REFRESH_LEAD) || !c.refresh) return orgOf(c)
        const spent = c.refresh
        let t
        try {
          t = await renew(spent, "")
        } catch (e) {
          if (refused(e)) throw lapsed(c, e)
          // a hiccup while the token still runs: go on with it
          if (c.expires > 0 && Date.now() < c.expires) return orgOf(c)
          throw e
        }
        await rotate(c, t, spent)
        await save(c)
        onRenew?.()
        return c
      })

    // mendOrg answers Factory refusing a request: an active org it
    // can't reach is left off and whoami asked again without it; with
    // no header sent, the token is put in the first org /api/cli/org
    // lists. Any other 403 to an account that sent no org asks whoami
    // for one. True when the request is worth sending again; onRenew is
    // told when the token was.
    const mendOrg = (status, text, onRenew) =>
      locked(async () => {
        if (status !== 403) return false
        const isOrg = orgRefused(status, text)
        const c = latest(await current())
        if (c.key) return false // an API key carries no org droid would send
        if (c.activeOrganizationId) {
          if (!isOrg) return false // the org was sent: the refusal is about something else
          const was = c.activeOrganizationId
          c.activeOrganizationId = ""
          if ((await reconcile(c)) && c.activeOrganizationId === was) c.activeOrganizationId = "" // whoami names the org refused: send none
          ask(c)
          await save(c)
          return true
        }
        if (!isOrg) {
          ask(c)
          if ((await reconcile(c)) && c.activeOrganizationId) {
            await save(c)
            return true
          }
          return false
        }
        if (!c.refresh) return false
        let org = ""
        try {
          org = await firstOrg(c)
        } catch {}
        if (!org) return false
        const spent = c.refresh
        let t
        try {
          t = await renew(spent, org)
        } catch {
          return false
        }
        applyTokens(c, t)
        c.orgId = org
        took(spent, c)
        await save(c)
        onRenew?.()
        return true
      })

    return { fresh, mendOrg }
  }

  // refresh is what magpie's auth.refresh runs: magpie renews the sign-in
  // MAGPIE_LEAD before its end and saves what this gives. Under the same
  // lock as the renewal before a request, so the two never spend one
  // refresh token.
  const refresh = (auth) =>
    locked(async () => {
      const c = latest({ ...auth })
      // renewed here already, the store not yet saying so
      if (c.access !== auth.access && c.expires > 0 && Date.now() < c.expires - MAGPIE_LEAD) return renewal(c)
      const spent = c.refresh
      let t
      try {
        t = await renew(spent, "")
      } catch (e) {
        if (refused(e)) throw lapsed(c, e)
        throw e
      }
      await rotate(c, t, spent)
      return renewal(c)
    })

  return { account, refresh }
}
