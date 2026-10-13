// Factory: the device-code sign-in.
import { claim, claims, expiry } from "./jwt.mjs"
import { authenticate, firstOrg, renew, whoami, workos } from "./api.mjs"
import { CLIENT_ID } from "./constants.mjs"
import { signInFailure } from "./errors.mjs"
import { adoptIdentity, adoptPlace, applyTokens } from "./session.mjs"
import { sleep } from "@astragate-community/plugin-kit"

// signedInWith is the account WorkOS just signed in, as droid keeps it: a
// token that names no org (the JWT's external_org_id or org_id) is put in
// the first org /api/cli/org lists, and whoami, asked without an org header,
// gives Factory's own id for the org the token is in (the active org droid
// then sends as X-Factory-Org-Id) and where Factory serves it from. droid
// carries on without either when they fail.
export async function signedInWith(t) {
  const cl = claims(t.access_token)
  const c = {
    access: t.access_token,
    refresh: t.refresh_token ?? "",
    expires: expiry(t.access_token),
    orgId: t.organization_id || claim(cl, "org_id"),
    email: t.user?.email || claim(cl, "email"),
    userId: t.user?.id || claim(cl, "sub"),
    activeOrganizationId: "",
    region: "",
    premBaseHost: "",
  }
  if (!c.orgId && !claim(cl, "external_org_id")) {
    let org = ""
    try {
      org = await firstOrg(c)
    } catch {}
    if (org) {
      const r = await renew(c.refresh, org)
      applyTokens(c, r)
      c.orgId = org
    }
  }
  try {
    const who = await whoami(c)
    c.activeOrganizationId = who.orgId ?? ""
    adoptPlace(c, who)
    adoptIdentity(c, who)
  } catch (e) {
    if (!c.email && !c.userId) throw e
  }
  const user = c.email || c.userId
  if (!user) throw new Error("signed in, but Factory didn't say whose account it is; try again")
  return { ...c, accountId: user }
}

export async function deviceSignIn() {
  const { text, status } = await workos("/authorize/device", { client_id: CLIENT_ID })
  if (status !== 200) throw signInFailure(status, text)
  const dc = JSON.parse(text)
  if (!dc.device_code || !dc.user_code) throw new Error("Factory's sign-in gave no device code")
  let interval = Math.max(dc.interval ?? 0, 1) * 1000
  // WorkOS answers expired_token once the code lapses; stop a little after
  // that regardless, so a lost poll can't run forever
  const until = Date.now() + (Math.max(dc.expires_in ?? 0, 300) + 30) * 1000
  return {
    url: dc.verification_uri_complete || dc.verification_uri,
    instructions: `Confirm the code ${dc.user_code} on Factory's page`,
    method: "auto",
    async callback() {
      for (;;) {
        await sleep(interval)
        if (Date.now() > until) throw new Error("the code expired; start again")
        let t
        try {
          t = await authenticate({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: dc.device_code,
            client_id: CLIENT_ID,
          })
        } catch {
          continue // a hiccup: ask again
        }
        if (t.error === "authorization_pending") continue
        if (t.error === "slow_down") {
          interval += 1000
          continue
        }
        if (t.error === "expired_token") throw new Error("the code expired; start again")
        if (t.error === "access_denied") throw new Error("the sign-in was declined")
        if (t.error || !t.access_token) throw new Error("Factory: " + (`${t.error ?? ""} ${t.error_description ?? ""}`.trim() || "no token came back"))
        const c = await signedInWith(t)
        return { type: "success", ...c }
      }
    },
  }
}