// Antigravity: signing in with Google, as the Antigravity app does — its OAuth client, PKCE, a loopback redirect.
import { challengeOf, listenOnFirstFree, randomToken, resultPage } from "@astragate-community/plugin-kit"
import { exchangeCode, setup, whoIs } from "./api.mjs"
import { AUTHORIZE_URL, CALLBACK_HOST, CALLBACK_PATH, CALLBACK_PORTS, CLIENT_ID, ID, SCOPES, SIGN_IN_TIMEOUT } from "./constants.mjs"

/** The address of Google's sign-in page for a sign-in that comes back to `redirect`. */
export function authorizeURL(redirect, state, verifier) {
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
  })
  return `${AUTHORIZE_URL}?${q}`
}

const redirectOf = (port) => `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`

/**
 * What the sign-in page sent the browser back with, from what was pasted: the whole address of the page it came to,
 * or the bare code. { code } or { error }.
 */
export function readCode(pasted, state) {
  const text = String(pasted ?? "").trim()
  if (!text) return { error: "no code was given" }
  if (!/[?&=]/.test(text) && !/^https?:/i.test(text)) return { code: text }
  let q
  try {
    q = new URL(text.startsWith("http") ? text : "http://x/?" + text.replace(/^\?/, "")).searchParams
  } catch {
    return { error: "that isn't the address the sign-in page came back to" }
  }
  if (q.get("error")) return { error: q.get("error_description") || q.get("error") }
  if (q.get("state") && q.get("state") !== state) return { error: "that address is from another sign-in; start this one again" }
  return q.get("code") ? { code: q.get("code") } : { error: "that address holds no code" }
}

// The account a code makes: its tokens, whose they are, and (when Code Assist says) its project and plan
async function signedIn(code, verifier, redirect) {
  const t = await exchangeCode(code, verifier, redirect)
  if (!t.access_token || !t.refresh_token) throw new Error("Google sent back no refresh token; remove Antigravity from the account's connected apps (myaccount.google.com/permissions) and sign in again")
  const email = await whoIs(t.access_token)
  // A project Code Assist can't give yet is asked for again with the first request, which then says why
  const s = await setup(t.access_token).catch(() => ({ project: "", plan: "", tier: "", paid: "" }))
  return { type: "success", provider: ID, refresh: t.refresh_token, access: t.access_token, expires: Date.now() + (t.expires_in > 0 ? t.expires_in : 3600) * 1000,
    accountId: email, project: s.project, plan: s.plan, tier: s.tier, paid: s.paid }
}

/** The sign-in on this machine: Google's page opens in the browser, and the sign-in comes back to a port listened on here. */
export async function browserSignIn() {
  const { server, port } = await listenOnFirstFree(CALLBACK_PORTS, "the ports Antigravity's sign-in comes back to are all busy; close the program using them and try again")
  const state = randomToken(24)
  const verifier = randomToken(48)
  const redirect = redirectOf(port)
  let waiting = true
  let settle
  const done = new Promise((r) => (settle = r))
  const finish = (result) => {
    if (!waiting) return
    waiting = false
    settle(result)
  }
  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${CALLBACK_HOST}:${port}`)
    const html = (code, body) => {
      res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" })
      res.end(body)
    }
    if (url.pathname !== CALLBACK_PATH) return res.writeHead(404).end()
    if (!waiting) return html(200, resultPage(false, "This sign-in is over", "Start it again."))
    const q = url.searchParams
    const fail = (msg) => {
      finish({ type: "failed", error: msg })
      html(200, resultPage(false, "Sign-in didn't finish", msg))
    }
    if (q.get("state") !== state) return html(200, resultPage(false, "This link isn't from this sign-in", "Start it again."))
    if (q.get("error")) return fail(q.get("error_description") || q.get("error"))
    if (!q.get("code")) return fail("Google sent back no code")
    try {
      const r = await signedIn(q.get("code"), verifier, redirect)
      finish(r)
      html(200, resultPage(true, "You're signed in", `${r.accountId} is signed in. You can close this tab.`))
    } catch (e) {
      fail(e.message)
    }
  })
  const timer = setTimeout(() => finish({ type: "failed", error: "the sign-in timed out" }), SIGN_IN_TIMEOUT)
  done.then(() => {
    clearTimeout(timer)
    setTimeout(() => server.close(), 10_000).unref?.()
  })
  return {
    url: authorizeURL(redirect, state, verifier),
    instructions: "Sign in with the Google account to use Antigravity with. Google may suspend an account it sees used outside Antigravity: use one you can afford to lose.",
    method: "auto",
    callback: () => done,
  }
}

/**
 * The sign-in where the browser is not on this machine (a server, a container): Google's page is opened anywhere, and
 * the address it ends up on — which fails to load there — or the code in it is pasted back.
 */
export async function pasteSignIn() {
  const state = randomToken(24)
  const verifier = randomToken(48)
  const redirect = redirectOf(CALLBACK_PORTS[0])
  return {
    url: authorizeURL(redirect, state, verifier),
    instructions:
      "Sign in with the Google account to use Antigravity with. The page it ends on won't load: copy its whole address from the browser's address bar and paste it here. " +
      "Google may suspend an account it sees used outside Antigravity: use one you can afford to lose.",
    method: "code",
    callback: async (pasted) => {
      const r = readCode(pasted, state)
      if (r.error) return { type: "failed", error: r.error }
      try {
        return await signedIn(r.code, verifier, redirect)
      } catch (e) {
        return { type: "failed", error: e.message }
      }
    },
  }
}
