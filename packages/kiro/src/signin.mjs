// Kiro: signing in — Kiro's sign-in page (Google, GitHub, AWS Builder ID, IAM Identity Center), or kiro-cli's / the IDE's.
import { challengeOf, listenOnFirstFree, randomToken, resultPage } from "@astragate-community/plugin-kit"
import { callerOf, profileOf, regionOf, usageLimits } from "./api.mjs"
import { AUTH_SERVICE, CALLBACK_PORTS, ID, IDE_UA, PORTAL, SCOPES, SIGN_IN_TIMEOUT, isBuilderID, oidc } from "./constants.mjs"
import { tryJSON } from "./errors.mjs"
import { fresh } from "./session.mjs"
import { readCLI, readIDE } from "./stores.mjs"
import { planName } from "./usage.mjs"

// signInPost posts JSON to Kiro's auth service or AWS's sign-in.
async function signInPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": IDE_UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    const e = tryJSON(text) ?? {}
    throw new Error(`the sign-in was refused (${res.status}): ${e.error_description || e.message || e.error || res.statusText}`)
  }
  return JSON.parse(text)
}

const expiry = (s) => Date.now() + (s > 0 ? s : 3600) * 1000

// whoIs names a new sign-in with the email Kiro has for it, and its plan.
async function whoIs(c) {
  try {
    const profile = c.profile || (await profileOf(c))
    const a = { ...callerOf(c), profile, region: regionOf(profile, c.region) }
    const l = await usageLimits(a, true)
    return { profile, email: l?.userInfo?.email ?? "", plan: planName(l?.subscriptionInfo?.subscriptionTitle) }
  } catch {
    return { profile: c.profile ?? "", email: "", plan: "" }
  }
}

// the sign-in AWS gave back for the code its page returned
async function awsSignIn(aws, awsRedirect, code) {
  const t = await signInPost(oidc(aws.region) + "/token", { clientId: aws.clientId, clientSecret: aws.clientSecret,
    grantType: "authorization_code", redirectUri: awsRedirect, code, codeVerifier: aws.verifier })
  if (!t.accessToken) throw new Error("AWS sent back no token")
  return { access: t.accessToken, refresh: t.refreshToken ?? "", expires: expiry(t.expiresIn), method: "idc", loginProvider: aws.provider,
    region: aws.region, clientId: aws.clientId, clientSecret: aws.clientSecret, profile: "", builderID: isBuilderID(aws.provider) }
}

// the sign-in Kiro's auth service gave back for the code Google's or GitHub's page returned
async function socialSignIn(code, verifier, redirectUri, opt) {
  const t = await signInPost(AUTH_SERVICE + "/oauth/token", { code, code_verifier: verifier, redirect_uri: redirectUri })
  if (!t.accessToken) throw new Error("Kiro sent back no token")
  return { access: t.accessToken, refresh: t.refreshToken ?? "", expires: expiry(t.expiresIn), method: "social",
    loginProvider: opt === "google" ? "Google" : "Github", region: "us-east-1", profile: t.profileArn ?? "" }
}

// registerAws registers a client for this sign-in at AWS and gives what the browser follows on to AWS with:
// the client, the state and verifier of that leg, and the URL.
async function registerAws(opt, issuer, region, awsRedirect) {
  const reg = await signInPost(oidc(region) + "/client/register", { clientName: "Kiro IDE", clientType: "public", scopes: SCOPES,
    grantTypes: ["authorization_code", "refresh_token"], redirectUris: ["http://127.0.0.1/oauth/callback"], issuerUrl: issuer })
  if (!reg.clientId) throw new Error("AWS registered no client")
  const aws = { region, clientId: reg.clientId, clientSecret: reg.clientSecret,
    provider: { builderid: "BuilderId", awsidc: "Enterprise", internal: "Internal" }[opt], state: randomToken(24), verifier: randomToken(48) }
  const a = new URLSearchParams({ response_type: "code", client_id: aws.clientId, redirect_uri: awsRedirect, scopes: SCOPES.join(","),
    state: aws.state, code_challenge: challengeOf(aws.verifier), code_challenge_method: "S256" })
  return { aws, url: `${oidc(region)}/authorize?${a}` }
}

// browserSignIn is the IDE's: Kiro's sign-in page, back to a port here.
export async function browserSignIn() {
  const { server, port } = await listenOnFirstFree(CALLBACK_PORTS,
    "the ports Kiro's sign-in comes back to are all busy; close the Kiro IDE's sign-in and try again")
  const state = randomToken(24)
  const verifier = randomToken(48)
  const redirect = `http://localhost:${port}`
  let aws = {} // once Kiro's page has sent the browser on to AWS
  const awsRedirect = `http://127.0.0.1:${port}/oauth/callback`
  let waiting = true
  let settle
  const done = new Promise((r) => (settle = r))
  const finish = (result) => {
    if (!waiting) return
    waiting = false
    settle(result)
  }

  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", redirect)
    const html = (code, body) => {
      res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" })
      res.end(body)
    }
    if (url.pathname !== "/oauth/callback" && url.pathname !== "/signin/callback") return res.writeHead(404).end()
    const q = url.searchParams
    if (!waiting) return html(200, resultPage(false, "This sign-in is over", "Start it again."))
    const fail = (msg) => {
      finish({ type: "failed", error: msg })
      html(200, resultPage(false, "Sign-in didn't finish", msg))
    }
    if (q.get("error")) return fail(q.get("error_description") || q.get("error"))
    let c
    try {
      if (aws.state && q.get("state") === aws.state) {
        // back from AWS
        if (!q.get("code")) return fail("AWS sent back no code")
        c = await awsSignIn(aws, awsRedirect, q.get("code"))
      } else if (q.get("state") !== state) {
        // not ours: someone else's page, or a stale tab
        return html(200, resultPage(false, "This link isn't from this sign-in", "Start it again."))
      } else {
        const opt = q.get("login_option") ?? ""
        if (opt === "google" || opt === "github") {
          c = await socialSignIn(q.get("code"), verifier, redirect + url.pathname + "?login_option=" + opt, opt)
        } else if (opt === "builderid" || opt === "awsidc" || opt === "internal") {
          // on to AWS, with a client registered for this sign-in
          const issuer = q.get("issuer_url")
          const region = q.get("idc_region")
          if (!issuer || !region) return fail("Kiro's page didn't say where to sign in at AWS")
          const next = await registerAws(opt, issuer, region, awsRedirect)
          aws = next.aws
          res.writeHead(302, { Location: next.url })
          return res.end()
        } else if (opt === "external_idp") {
          return fail("A company's own identity provider can't be signed in to here yet; sign in with `kiro-cli login`, and use Kiro CLI's sign-in")
        } else return fail(`Kiro's page came back with a sign-in this plugin doesn't know (${JSON.stringify(opt)})`)
      }
    } catch (e) {
      return fail(e.message)
    }
    const who = await whoIs(c)
    const user = who.email || "Kiro account"
    finish({ type: "success", provider: ID, refresh: c.refresh, access: c.access, expires: c.expires, accountId: user,
      method: c.method, loginProvider: c.loginProvider, region: c.region, profileArn: who.profile,
      ...(c.clientId ? { clientId: c.clientId, clientSecret: c.clientSecret } : {}), ...(who.plan ? { plan: who.plan } : {}) })
    html(200, resultPage(true, "You're signed in", `${user} is signed in. You can close this tab.`))
  })

  const timer = setTimeout(() => finish({ type: "failed", error: "the sign-in timed out" }), SIGN_IN_TIMEOUT)
  done.then(() => {
    clearTimeout(timer)
    setTimeout(() => server.close(), 10_000).unref?.()
  })
  const q = new URLSearchParams({ state, code_challenge: challengeOf(verifier), code_challenge_method: "S256", redirect_uri: redirect,
    redirect_from: "KiroIDE" })
  return {
    url: `${PORTAL}/signin?${q}`,
    instructions: "Sign in to Kiro with Google, GitHub, AWS Builder ID or IAM Identity Center.",
    method: "auto",
    callback: () => done,
  }
}

// ownSignIn uses kiro-cli's sign-in, else the Kiro IDE's: nothing is copied,
// they are read where they keep it each time.
export async function ownSignIn() {
  return {
    url: "",
    instructions: "Uses the account kiro-cli or the Kiro IDE is signed in to.",
    method: "auto",
    callback: async () => {
      const cli = await readCLI()
      const c = cli ?? (await readIDE())
      if (!c) return { type: "failed", error: "neither kiro-cli nor the Kiro IDE is signed in" }
      const who = fresh(c) ? await whoIs(c) : { email: "", plan: "" }
      return { type: "success", provider: ID, refresh: "", access: "", expires: 0, source: cli ? "kiro-cli" : "kiro-ide",
        accountId: who.email || (cli ? "kiro-cli's account" : "Kiro IDE's account"), ...(who.plan ? { plan: who.plan } : {}) }
    },
  }
}
