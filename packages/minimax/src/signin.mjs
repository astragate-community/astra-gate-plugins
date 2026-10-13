// MiniMax Code: signing in with the OAuth device flow (PKCE).
import { challengeOf, randomToken, sleep } from "@astragate-community/plugin-kit"
import { AUDIENCE, CLIENT_ID, DEVICE_GRANT, SCOPE, SIGN_IN_MS } from "./constants.mjs"
import { OAuthError, identity, postForm } from "./api.mjs"
import { token } from "./session.mjs"
import { pos, str } from "./values.mjs"

export async function startDevice(site) {
  const verifier = randomToken(32)
  const challenge = challengeOf(verifier)
  const r = await postForm(site.account + "/oauth2/device/code", {
    client_id: CLIENT_ID,
    scope: SCOPE,
    audience: AUDIENCE,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  if (!r.ok) throw new OAuthError(r.error ?? "oauth_request_failed", r.status)
  const b = r.body
  const userCode = str(b, "user_code")
  const deviceCode = str(b, "device_code")
  const expiredIn = pos(b, "expired_in")
  // MiniMax's own variant: no device_code, the user code polled for, an
  // end that may be an at-ms, an interval in ms
  const byUser = !deviceCode && !!userCode && expiredIn !== undefined
  const uri = str(b, "verification_uri") ?? str(b, "verification_url")
  const at = expiredIn === undefined ? undefined : expiredIn < 1e12 ? expiredIn : Math.ceil((expiredIn - Date.now()) / 1000)
  const expiresIn = pos(b, "expires_in") ?? (at > 0 ? at : undefined)
  const interval = pos(b, "interval")
  if (!(deviceCode ?? (byUser ? userCode : undefined)) || !userCode || !uri) throw new OAuthError("invalid_device_authorization_response")
  return {
    verifier,
    userCode,
    poll: byUser ? { user_code: userCode } : { device_code: deviceCode },
    url: str(b, "verification_uri_complete") ?? uri,
    deadline: Date.now() + (expiresIn ? expiresIn * 1000 : SIGN_IN_MS),
    intervalMs: byUser && interval !== undefined ? interval : (interval ?? 5) * 1000,
  }
}

export async function pollDevice(site, d) {
  let wait = d.intervalMs
  while (Date.now() < d.deadline) {
    await sleep(wait)
    const r = await postForm(site.account + "/oauth2/token", {
      grant_type: DEVICE_GRANT,
      ...d.poll,
      client_id: CLIENT_ID,
      code_verifier: d.verifier,
    })
    const status = str(r.body, "status")
    if (r.ok && status === "pending") continue
    if (r.ok && status === "slow_down") {
      wait += 5000
      continue
    }
    if (r.ok && (status === "denied" || status === "access_denied")) throw new OAuthError("access_denied", 0, "the sign-in was turned down")
    if (r.ok && (status === "expired" || status === "expired_token")) throw new OAuthError("expired_token", 0, "the sign-in code expired")
    if (r.ok) return token(r.body)
    if (r.error === "authorization_pending") continue
    if (r.error === "slow_down") {
      wait += 5000
      continue
    }
    throw new OAuthError(r.error ?? "device_authorization_failed", r.status)
  }
  throw new OAuthError("expired_token", 0, "the sign-in code expired")
}

/** What a finished sign-in saves: the tokens and who the account is. */
export function signedInResult(site, t, who) {
  const uid = who.realUserID ?? t.accountID ?? t.subject ?? ""
  return {
    type: "success",
    access: t.access,
    refresh: t.refresh,
    expires: t.expires,
    accountId: who.email || who.name || uid || site.name,
    uid,
    ...(who.realUserID ? { realUserID: who.realUserID } : {}),
    ...(who.email ? { email: who.email } : {}),
    ...(who.name ? { name: who.name } : {}),
  }
}

/** The OpenCode / magpie auth method: MiniMax Code's device sign-in. */
export const signInMethod = (site) => ({
  type: "oauth",
  label: `${site.name} account`,
  async authorize() {
    const d = await startDevice(site)
    return {
      url: d.url,
      instructions: `Sign in to ${site.name} in the browser and confirm the code ${d.userCode}; this finishes by itself.`,
      method: "auto",
      async callback() {
        try {
          const t = await pollDevice(site, d)
          let who = {}
          try {
            who = await identity(site, t.access)
          } catch {}
          return signedInResult(site, t, who)
        } catch (e) {
          return { type: "failed", error: `${site.name} sign-in: ${e?.message ?? e}` }
        }
      },
    }
  },
})
