// Xiaomi MiMo: the sign-in as OpenCode stores it.
import { HOSTS, REGION, RENEW_AFTER, baseOf } from "./constants.mjs"
import { tryJSON } from "./json.mjs"

// The sign-in is kept as OpenCode keeps an OAuth one: refresh is the
// Xiaomi account (what signs it on again), access the session's cookies,
// expires when the app would sign on again.
export function toAuth(creds, cookies, issued) {
  return {
    type: "oauth",
    refresh: JSON.stringify(creds),
    access: JSON.stringify(cookies),
    expires: issued + RENEW_AFTER,
    accountId: creds.userId,
  }
}

// the stored sign-in as {creds, cookies, expires}, or null when it isn't one
export function fromAuth(auth) {
  if (auth?.type !== "oauth") return null
  const creds = tryJSON(auth.refresh)
  const cookies = tryJSON(auth.access || "{}") ?? {}
  if (!creds?.passToken || !creds?.userId) return null
  creds.base ||= baseOf(creds.region) || HOSTS[REGION]
  return { creds, cookies, expires: Number(auth.expires) || 0 }
}
