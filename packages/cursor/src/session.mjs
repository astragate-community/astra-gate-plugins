// An account's token: a JWT's expiry, an API key's exchange, and the token a sign-in stands for.
import { hashOf } from "./hash.mjs"
import { API, CLI_MARK, SOON } from "./constants.mjs"
import { headersFor } from "./api.mjs"
import { AuthError, httpError } from "./errors.mjs"
import { expiry } from "./jwt.mjs"
import { cliTokenNow } from "./cli.mjs"

// exchanged are API keys' tokens, by the key's hash.
const exchanged = new Map()

// keyToken is the access token for a Cursor API key, as the CLI gets it
// for CURSOR_API_KEY: /auth/exchange_user_api_key, again when it runs out.
export async function keyToken(key) {
  const h = hashOf(key)
  const had = exchanged.get(h)
  if (had && (!had.exp || had.exp - Date.now() > SOON)) return had.tok
  const res = await fetch(API + "/auth/exchange_user_api_key", {
    method: "POST",
    headers: { ...(await headersFor(key)), "Connect-Protocol-Version": undefined },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => {
    throw httpError("couldn't reach Cursor's API: " + e.message, 502)
  })
  if (res.status >= 500) throw httpError(`exchange_user_api_key: HTTP ${res.status}`, 502)
  const j = res.ok ? await res.json().catch(() => null) : null
  if (!j?.accessToken) throw new AuthError("Cursor didn't take this API key")
  exchanged.set(h, { tok: j.accessToken, exp: expiry(j.accessToken) })
  return j.accessToken
}

// tokenOf is the token to call Cursor's API with, for a sign-in.
export async function tokenOf(auth) {
  if (auth?.type === "api" && auth.key) return keyToken(auth.key)
  if (auth?.type !== "oauth") throw new AuthError("Cursor isn't signed in")
  if (auth.refresh === CLI_MARK) return cliTokenNow()
  const exp = auth.expires || expiry(auth.access)
  if (!auth.access) throw new AuthError("Cursor isn't signed in")
  // Cursor's sign-in has nothing to renew it with: cursor-agent itself
  // signs in again when it runs out (about two months)
  if (exp && exp <= Date.now()) throw new AuthError("Cursor's sign-in has run out; sign in to Cursor again")
  return auth.access
}
