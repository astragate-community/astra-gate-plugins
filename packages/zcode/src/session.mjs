// An account's stored sign-in as the requests need it: the state in `refresh`, the session token's expiry, a team seat's key.
import { PROVIDER } from "./constants.mjs"
import { ownSignIn } from "./local.mjs"
import { teamKey } from "./keys.mjs"
import { SITES, siteOf } from "./sites.mjs"
import { anyDevice } from "./api.mjs"
import { isTeam } from "./util.mjs"

export function jwtExpiry(jwt) {
  const p = String(jwt ?? "").split(".")
  if (p.length !== 3) return 0
  try {
    const claims = JSON.parse(Buffer.from(p[1], "base64url").toString("utf8"))
    return Number(claims.exp) > 0 ? Number(claims.exp) * 1000 : 0
  } catch {
    return 0
  }
}
export const jwtExpired = (jwt) => {
  const t = jwtExpiry(jwt)
  return t > 0 && Date.now() > t
}

// stateOf is a stored sign-in as the requests need it.
export function stateOf(auth) {
  if (auth?.type === "oauth") {
    let s = {}
    try {
      s = JSON.parse(auth.refresh)
    } catch {}
    if (s.source === "zcode") {
      // ZCode's own, read now, while ZCode is signed in to this same
      // account. Signed out, or signed in to another account since, it is
      // what it was when this was signed in: another account's key would
      // send this account's requests as that one, and an expired session
      // says sign in again (EXPIRED) rather than borrowing another's.
      const own = ownSignIn()
      if (own && own.user === String(auth.accountId ?? "")) {
        const now = { ...own }
        delete now.user
        s = { source: "zcode", device: s.device, plan: s.plan, ...now }
      }
    }
    const site = siteOf(s.site)
    return { ...s, site, base: s.base || SITES[site].base, key: s.key ?? (s.jwt ? "" : auth.access), device: s.device || anyDevice }
  }
  if (auth?.type === "api") {
    const site = siteOf(auth.metadata?.site)
    return { site, base: SITES[site].base, key: String(auth.key ?? "").trim(), device: anyDevice }
  }
  return null
}

// keyOf is the key a state sends with: a team seat's, made when the sign-in kept none, and then
// written back to the stored sign-in so the next read has it.
export async function keyOf(s, auth, client, id = PROVIDER) {
  if (!isTeam(s) || s.key) return s.key
  const key = await teamKey(s)
  if (auth?.type === "oauth") {
    const next = { ...auth, refresh: JSON.stringify({ ...s, key }), access: key }
    await client?.auth?.set?.({ path: { id }, body: next }).catch?.(() => {})
  }
  return key
}
