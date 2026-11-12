// Kiro: signing in — Kiro's sign-in page (Google, GitHub, AWS Builder ID, IAM Identity Center), or a Kiro API key.
//
// A plugin cannot listen on a port, so the browser sign-in is the paste way: Kiro's page sends the browser back to
// localhost:3128, which fails to load; the whole address is pasted back. Google and GitHub come back with a code Kiro's
// auth service trades for tokens; Builder ID and Identity Center come back with where to sign in at AWS, which is a
// second page and a second pasted address.
import { crypto, encoding, http, providers, t, ui } from "astra"
import { callerOf, profileOf, regionOf, usageLimits } from "./api.js"
import { AUTH_SERVICE, CALLBACK_PORT, ID, IDE_UA, PORTAL, SCOPES, isBuilderID, oidc } from "./constants.js"
import { tryJSON } from "./errors.js"
import { planName } from "./usage.js"

export const randomToken = (n) => encoding.base64url.encode(crypto.randomBytes(n))
export const challengeOf = (verifier) => crypto.digest("sha256", verifier, { encoding: "base64url" })
const form = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v))).join("&")

// signInPost posts JSON to Kiro's auth service or AWS's sign-in.
async function signInPost(url, body) {
  const res = await http.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": IDE_UA },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  })
  const text = await res.text()
  if (!res.ok) {
    const e = tryJSON(text) ?? {}
    throw new Error(`the sign-in was refused (${res.status}): ${e.error_description || e.message || e.error || res.status}`)
  }
  return JSON.parse(text)
}

const expiry = (s) => Date.now() + (s > 0 ? s : 3600) * 1000

// whoIs names a new sign-in with the email Kiro has for it, and its plan.
export async function whoIs(c) {
  let profile = c.profile ?? ""
  try {
    profile ||= await profileOf(c)
    const a = { ...callerOf(c), profile, region: regionOf(profile, c.region) }
    const l = await usageLimits(a, true)
    return { profile, email: l?.userInfo?.email ?? "", plan: planName(l?.subscriptionInfo?.subscriptionTitle) }
  } catch {
    return { profile, email: "", plan: "" }
  }
}

// the sign-in AWS gave back for the code its page returned
export async function awsSignIn(aws, awsRedirect, code) {
  const tok = await signInPost(oidc(aws.region) + "/token", { clientId: aws.clientId, clientSecret: aws.clientSecret,
    grantType: "authorization_code", redirectUri: awsRedirect, code, codeVerifier: aws.verifier })
  if (!tok.accessToken) throw new Error("AWS sent back no token")
  return { access: tok.accessToken, refresh: tok.refreshToken ?? "", expires: expiry(tok.expiresIn), method: "idc", loginProvider: aws.provider,
    region: aws.region, clientId: aws.clientId, clientSecret: aws.clientSecret, profile: "", builderID: isBuilderID(aws.provider) }
}

// the sign-in Kiro's auth service gave back for the code Google's or GitHub's page returned
export async function socialSignIn(code, verifier, redirectUri, opt) {
  const tok = await signInPost(AUTH_SERVICE + "/oauth/token", { code, code_verifier: verifier, redirect_uri: redirectUri })
  if (!tok.accessToken) throw new Error("Kiro sent back no token")
  return { access: tok.accessToken, refresh: tok.refreshToken ?? "", expires: expiry(tok.expiresIn), method: "social",
    loginProvider: opt === "google" ? "Google" : "Github", region: "us-east-1", profile: tok.profileArn ?? "" }
}

// registerAws registers a client for this sign-in at AWS and gives what the browser follows on to AWS with:
// the client, the state and verifier of that leg, and the URL.
export async function registerAws(opt, issuer, region, awsRedirect) {
  const reg = await signInPost(oidc(region) + "/client/register", { clientName: "Kiro IDE", clientType: "public", scopes: SCOPES,
    grantTypes: ["authorization_code", "refresh_token"], redirectUris: ["http://127.0.0.1/oauth/callback"], issuerUrl: issuer })
  if (!reg.clientId) throw new Error("AWS registered no client")
  const aws = { region, clientId: reg.clientId, clientSecret: reg.clientSecret,
    provider: { builderid: "BuilderId", awsidc: "Enterprise", internal: "Internal" }[opt], state: randomToken(24), verifier: randomToken(48) }
  const url = `${oidc(region)}/authorize?${form({ response_type: "code", client_id: aws.clientId, redirect_uri: awsRedirect, scopes: SCOPES.join(","),
    state: aws.state, code_challenge: challengeOf(aws.verifier), code_challenge_method: "S256" })}`
  return { aws, url }
}

const decode = (s) => decodeURIComponent(String(s).replace(/\+/g, " "))

/** What a pasted address says: its path and query as an object. null for text that holds no query at all. */
export function readAddress(pasted) {
  const text = String(pasted ?? "").trim()
  if (!text) return null
  const m = /^(?:https?:\/\/[^/?#]*)?([^?#]*)(?:\?([^#]*))?/.exec(text)
  const q = {}
  for (const pair of (m?.[2] ?? "").split("&")) {
    if (!pair) continue
    const j = pair.indexOf("=")
    q[decode(j < 0 ? pair : pair.slice(0, j))] = j < 0 ? "" : decode(pair.slice(j + 1))
  }
  return { path: m?.[1] || "/", q }
}

const redirectOf = () => `http://localhost:${CALLBACK_PORT}`
const awsRedirectOf = () => `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`

/** The address of Kiro's sign-in page. */
export const portalURL = (state, verifier) =>
  `${PORTAL}/signin?${form({ state, code_challenge: challengeOf(verifier), code_challenge_method: "S256", redirect_uri: redirectOf(), redirect_from: "KiroIDE" })}`

/** Adds the account, or puts the new sign-in into the one of that key (a re-login). */
export async function keep(c, who, key) {
  const existing = await providers.accounts.list(ID)
  const k = who.email || key
  const info = { displayName: who.email || key, ...(who.email ? { email: who.email } : {}), ...(who.plan ? { plan: who.plan } : {}), status: "active",
    secret: JSON.stringify({ ...c, profile: who.profile || c.profile || "" }) }
  if (existing.some((a) => a.key === k)) await providers.accounts.update(ID, k, info)
  else await providers.accounts.add(ID, { key: k, ...info })
}

async function done(c, key, ctx) {
  await keep(c, await whoIs(c), key)
  ctx.toast({ message: t("signIn.done"), tone: "success" })
  ctx.close({ ok: true })
}

export const signIn = ui.defineView({
  state: { step: "menu", url: "", state: "", verifier: "", aws: null, error: "" },
  render: (s) => {
    const kids = [ui.Heading({ value: t("signIn.title"), level: 2 })]
    if (s.error) kids.push(ui.Alert({ tone: "danger", message: s.error }))
    if (s.step === "menu") {
      kids.push(
        ui.Text({ value: t("signIn.body") }),
        ui.Button({ label: t("signIn.browser"), variant: "primary", onPress: "start" }),
        ui.Divider({ label: t("signIn.or") }),
        ui.Field({ label: t("signIn.key.label"), hint: t("signIn.key.hint") }, ui.PasswordField({ name: "apiKey", a11yLabel: t("signIn.key.label") })),
        ui.Button({ label: t("signIn.key.save"), onPress: "saveKey" }),
      )
    } else {
      kids.push(
        ui.Text({ value: s.step === "kiro" ? t("signIn.paste.kiro") : t("signIn.paste.aws") }),
        ui.Link({ label: t("signIn.open"), href: s.url }),
        ui.Field({ label: t("signIn.paste.label") }, ui.TextField({ name: "address", a11yLabel: t("signIn.paste.label") })),
        ui.Button({ label: t("signIn.finish"), variant: "primary", onPress: s.step === "kiro" ? "finishKiro" : "finishAws" }),
      )
    }
    return ui.Stack({ gap: "4" }, kids)
  },
  actions: {
    start: (s, _a, ctx) => {
      const state = randomToken(24)
      const verifier = randomToken(48)
      const url = portalURL(state, verifier)
      ctx.openExternal(url)
      return { ...s, step: "kiro", url, state, verifier, aws: null, error: "" }
    },

    saveKey: async (s, _a, ctx) => {
      const key = String(ctx.local.apiKey ?? "").trim()
      if (!key) return { ...s, error: t("signIn.key.empty") }
      const c = { method: "apikey", access: key, refresh: "", expires: 0, region: "us-east-1", profile: "" }
      try {
        c.profile = await profileOf(c)
        await done(c, "apikey-" + crypto.sha256(key).slice(0, 8), ctx)
      } catch (e) {
        return { ...s, error: String(e?.message ?? e) }
      }
    },

    // the address Kiro's page ended on
    finishKiro: async (s, _a, ctx) => {
      const a = readAddress(ctx.local.address)
      if (!a || !Object.keys(a.q).length) return { ...s, error: t("signIn.error.empty") }
      const q = a.q
      if (q.error) return { ...s, error: t("signIn.error.refused", { detail: q.error_description || q.error }) }
      if (q.state !== s.state) return { ...s, error: t("signIn.error.otherSignIn") }
      const opt = q.login_option ?? ""
      try {
        if (opt === "google" || opt === "github") {
          const c = await socialSignIn(q.code, s.verifier, redirectOf() + a.path + "?login_option=" + opt, opt)
          return await done(c, "kiro-" + opt, ctx)
        }
        if (opt === "builderid" || opt === "awsidc" || opt === "internal") {
          if (!q.issuer_url || !q.idc_region) return { ...s, error: t("signIn.error.noIssuer") }
          const next = await registerAws(opt, q.issuer_url, q.idc_region, awsRedirectOf())
          ctx.openExternal(next.url)
          return { ...s, step: "aws", url: next.url, aws: next.aws, error: "" }
        }
        if (opt === "external_idp") return { ...s, error: t("signIn.error.external") }
        return { ...s, error: t("signIn.error.unknown", { detail: opt }) }
      } catch (e) {
        return { ...s, error: String(e?.message ?? e) }
      }
    },

    // the address AWS's page ended on
    finishAws: async (s, _a, ctx) => {
      const a = readAddress(ctx.local.address)
      if (!a || !Object.keys(a.q).length) return { ...s, error: t("signIn.error.empty") }
      if (a.q.error) return { ...s, error: t("signIn.error.refused", { detail: a.q.error_description || a.q.error }) }
      if (a.q.state !== s.aws.state) return { ...s, error: t("signIn.error.otherSignIn") }
      if (!a.q.code) return { ...s, error: t("signIn.error.noCode") }
      try {
        return await done(await awsSignIn(s.aws, awsRedirectOf(), a.q.code), "kiro-" + s.aws.provider.toLowerCase(), ctx)
      } catch (e) {
        return { ...s, error: String(e?.message ?? e) }
      }
    },
  },
})
