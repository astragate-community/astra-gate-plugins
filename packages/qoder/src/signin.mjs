// Qoder: the sign-in — a PKCE device flow (qoder.com's page, then a poll of openapi.qoder.sh for the device
// token), whose device token is traded for the job token the model calls use.
import { randomUUID } from "node:crypto"
import { challengeOf, randomToken, sleep } from "@astragate-community/plugin-kit"
import { SIGN_IN_TIMEOUT } from "./constants.mjs"
import { openapi } from "./api.mjs"
import { deviceExpiry, expiresAt } from "./session.mjs"
import { vpcInstance, vpcSite } from "./sites.mjs"
import { blank } from "./util.mjs"

// pollDeviceToken asks for the device token every 2 seconds until the user has authorized it in the browser.
async function pollDeviceToken(site, { nonce, verifier }, until) {
  for (;;) {
    if (Date.now() > until) throw new Error(`${site.name}: the sign-in timed out; start again`)
    try {
      const r = await openapi(site, "/api/v1/deviceToken/poll", { query: { nonce, verifier, challenge_method: "S256" } })
      if (r.status === 200 && !blank(r.json?.token)) return r.json
    } catch {} // a hiccup: ask again
    await sleep(2000)
  }
}

// chatTokens is the token pair the model calls run on: the job token the device token is traded for, or, on a
// site whose job token is refused, the device token itself.
async function chatTokens(site, dt) {
  const jr = await openapi(site, "/api/v1/me/jobToken", { method: "POST", token: dt.token, body: { clientId: site.clientId } })
  if (jr.status === 200) {
    if (blank(jr.json?.token)) throw new Error(`${site.name} job token: empty token in response`)
    return { access: jr.json.token, refresh: jr.json.refresh_token ?? "", expires: expiresAt(jr.json) }
  }
  if (site.deviceChat && jr.status >= 400 && jr.status < 500) {
    // Qoder CN's CLI never makes a job token: its device token is what
    // signs the model calls, renewed as a device token
    return { access: dt.token, refresh: dt.refresh_token ?? "", expires: deviceExpiry(dt), deviceChat: true }
  }
  throw new Error(`${site.name} job token: status ${jr.status}: ${jr.text.trim().slice(0, 300)}`)
}

async function deviceSignIn(site) {
  const verifier = randomToken(64)
  const challenge = challengeOf(verifier)
  const nonce = randomUUID()
  const machineId = randomUUID()
  const q = new URLSearchParams({ challenge, challenge_method: "S256", nonce, machine_id: machineId, client_id: site.clientId })
  if (site.redirect) q.set("redirect_uri", site.redirect)
  const until = Date.now() + SIGN_IN_TIMEOUT
  return {
    url: `${site.web}/device/selectAccounts?${q}`,
    instructions: `Sign in to ${site.name} in the browser and authorize this device`,
    method: "auto",
    async callback() {
      const dt = await pollDeviceToken(site, { nonce, verifier }, until)
      const chat = await chatTokens(site, dt)
      let email = ""
      let name = ""
      let uid = dt.user_id
      try {
        const ui = await openapi(site, "/api/v1/userinfo", { token: dt.token })
        if (ui.status >= 200 && ui.status < 300) {
          ;[email, name] = [ui.json?.email ?? "", ui.json?.name ?? ""]
          // a VPC poll may give the token alone: the user is then the one
          // user info names (id, or its user_id / uid aliases)
          if (site.vpc && blank(uid)) uid = String(ui.json?.id ?? ui.json?.user_id ?? ui.json?.uid ?? "") || undefined
        }
      } catch {}
      if (site.vpc && blank(uid)) throw new Error(`${site.name} (${site.vpc}): the sign-in named no user`)
      return {
        type: "success",
        ...chat,
        // a VPC account is told apart from the same person's public one
        accountId: site.vpc ? `${email || uid} (${site.vpc})` : email || dt.user_id,
        uid,
        email,
        name: name || dt.user_name || "",
        machineId,
        deviceToken: dt.token,
        deviceRefresh: dt.refresh_token ?? "",
        ...(site.vpc ? { vpc: site.vpc } : {}),
      }
    },
  }
}

/** The sign-in methods a site offers: its own, and for Qoder CN an enterprise VPC one. */
export function signInMethods(site) {
  return [
    { type: "oauth", label: `Sign in with ${site.name}`, authorize: () => deviceSignIn(site) },
    // an enterprise VPC instance (Qoder CN), a method of its own so
    // that the sign-in above asks nothing new
    ...(site.vpcDomain
      ? [
          {
            type: "oauth",
            label: `Sign in with ${site.name} Enterprise (VPC)`,
            prompts: [
              {
                type: "text",
                key: "vpc",
                message: `Your enterprise's VPC instance: its name, or its address (<instance>.${site.vpcDomain})`,
                placeholder: `acme or acme.${site.vpcDomain}`,
                validate: (v) => (vpcInstance(v, site.vpcDomain) ? undefined : `Not a VPC instance: enter its name (letters, digits, -) or https://<instance>.${site.vpcDomain}`),
              },
            ],
            authorize: (inputs) => {
              const s = vpcSite(site, inputs?.vpc)
              if (!s) throw new Error(`Not a VPC instance: ${String(inputs?.vpc ?? "").slice(0, 100)}`)
              return deviceSignIn(s)
            },
          },
        ]
      : []),
  ]
}
