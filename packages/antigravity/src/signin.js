// Antigravity: signing in with Google, as the Antigravity app does — its OAuth client, PKCE, a loopback redirect. A plugin
// cannot listen on a port, so the one way is the paste way: Google's page ends on an address that fails to load where the
// browser runs; the whole address (or just its code) is pasted back here.
import { crypto, encoding, providers, t, ui } from "astra"
import { exchangeCode, setup, whoIs } from "./api.js"
import { AUTHORIZE_URL, ID, REDIRECT, SCOPES } from "./constants.js"
import { needsClient, oauthClient } from "./oauth.js"

/** Bytes as base64url, no padding. */
export const base64url = (bytes) => encoding.base64url.encode(Uint8Array.from(bytes))
export const randomToken = (n) => base64url(crypto.randomBytes(n))
export const challengeOf = (verifier) => crypto.digest("sha256", verifier, { encoding: "base64url" })

const form = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v))).join("&")

/** The address of Google's sign-in page for a sign-in that comes back to `redirect`. */
export function authorizeURL(client, redirect, state, verifier) {
  return `${AUTHORIZE_URL}?${form({
    client_id: client.id,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
  })}`
}

const decode = (s) => decodeURIComponent(String(s).replace(/\+/g, " "))
function queryOf(text) {
  const q = {}
  const i = text.indexOf("?")
  const rest = i >= 0 ? text.slice(i + 1) : text.replace(/^\?/, "")
  for (const pair of rest.split("#")[0].split("&")) {
    if (!pair) continue
    const j = pair.indexOf("=")
    q[decode(j < 0 ? pair : pair.slice(0, j))] = j < 0 ? "" : decode(pair.slice(j + 1))
  }
  return q
}

/**
 * What the sign-in page sent the browser back with, from what was pasted: the whole address of the page it came to,
 * or the bare code. { code } or { error } (an error is a message key of the locale).
 */
export function readCode(pasted, state) {
  const text = String(pasted ?? "").trim()
  if (!text) return { error: "signIn.error.empty" }
  if (!/[?&=]/.test(text) && !/^https?:/i.test(text)) return { code: text }
  if (/^https?:/i.test(text) && !/[?&]/.test(text)) return { error: "signIn.error.notAddress" }
  const q = queryOf(text)
  if (q.error) return { error: "signIn.error.google", detail: q.error_description || q.error }
  if (q.state && q.state !== state) return { error: "signIn.error.otherSignIn" }
  return q.code ? { code: q.code } : { error: "signIn.error.noCode" }
}

// The account a code makes: its tokens, whose they are, and (when Code Assist says) its project and plan
export async function signedIn(client, code, verifier) {
  const tok = await exchangeCode(client, code, verifier, REDIRECT)
  if (!tok.access_token || !tok.refresh_token) throw new Error("Google sent back no refresh token; remove Antigravity from the account's connected apps (myaccount.google.com/permissions) and sign in again")
  const email = await whoIs(tok.access_token)
  // A project Code Assist can't give yet is asked for again with the first request, which then says why
  const s = await setup(tok.access_token).catch(() => ({ project: "", plan: "", tier: "", paid: "" }))
  return {
    email,
    plan: s.plan,
    secret: { access: tok.access_token, refresh: tok.refresh_token, expires: Date.now() + (tok.expires_in > 0 ? tok.expires_in : 3600) * 1000, project: s.project, plan: s.plan, tier: s.tier, paid: s.paid },
  }
}

/** Adds the account, or puts the new sign-in into the one of that email (a re-login). */
export async function keep({ email, plan, secret }) {
  const existing = await providers.accounts.list(ID)
  const info = { displayName: email, email, ...(plan ? { plan } : {}), status: "active", secret: JSON.stringify(secret) }
  if (existing.some((a) => a.key === email)) await providers.accounts.update(ID, email, info)
  else await providers.accounts.add(ID, { key: email, ...info })
}

export const signIn = ui.defineView({
  state: { url: "", state: "", verifier: "", error: "", busy: false },
  render: (s) => {
    const missing = needsClient(oauthClient())
    const kids = [
      ui.Heading({ value: t("signIn.title"), level: 2 }),
      ui.Text({ value: t("signIn.body") }),
      ui.Alert({ tone: "warning", title: t("signIn.risk.title"), message: t("signIn.risk.body") }),
    ]
    if (missing) kids.push(ui.Alert({ tone: "danger", message: t("signIn.noClient") }));
    if (s.error) kids.push(ui.Alert({ tone: "danger", message: s.error }));
    if (!s.url) kids.push(ui.Button({ label: t("signIn.start"), variant: "primary", onPress: "start", disabled: missing }));
    else {
      kids.push(
        ui.Text({ value: t("signIn.paste.body") }),
        ui.Link({ label: t("signIn.open"), href: s.url }),
        ui.Field({ label: t("signIn.paste.label") }, ui.TextField({ name: "address", a11yLabel: t("signIn.paste.label") })),
        ui.Button({ label: t("signIn.finish"), variant: "primary", loading: s.busy, onPress: "finish" }),
      )
    }
    return ui.Stack({ gap: "4" }, kids)
  },
  actions: {
    start: (s, _a, ctx) => {
      const state = randomToken(24)
      const verifier = randomToken(48)
      const url = authorizeURL(oauthClient(), REDIRECT, state, verifier)
      ctx.openExternal(url)
      return { ...s, url, state, verifier, error: "" }
    },
    finish: async (s, _a, ctx) => {
      const r = readCode(ctx.local.address, s.state)
      if (r.error) return { ...s, error: t(r.error, { detail: r.detail ?? "" }) }
      try {
        await keep(await signedIn(oauthClient(), r.code, s.verifier))
      } catch (e) {
        return { ...s, error: String(e?.message ?? e) }
      }
      ctx.toast({ message: t("signIn.done"), tone: "success" })
      ctx.close({ ok: true })
    },
  },
})
