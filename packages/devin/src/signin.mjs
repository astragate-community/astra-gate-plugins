// Signing in: the devin CLI's own round (PKCE through app.devin.ai to a callback on 127.0.0.1), or the account
// the CLI is already signed in to.
import { readFile } from "node:fs/promises"
import { challengeOf, listenOnFirstFree, randomToken, resultPage } from "@astragate-community/plugin-kit"
import { AUTHORIZE, ID, SERVER, SIGN_IN_TIMEOUT } from "./constants.mjs"
import { exchange } from "./api.mjs"
import { cliCredentialsPath, homeFor, readCredentials } from "./cli.mjs"
import { identity, whoByKey } from "./identity.mjs"
import { serverUrl } from "./session.mjs"

// success names a key's account as Devin does when asked with the key
// (GetUserStatus), or, when Devin can't tell, as the CLI does in a data
// folder of the plugin's own: never by the CLI alone, which on Windows
// names its own account whatever key it is given (#17). A key Devin or the
// CLI says nobody is signed in with fails it; with neither able to tell,
// the account is just "Devin".
export async function success(key, server) {
  let who = await whoByKey(key, server)
  if (who === undefined) who = await identity(await homeFor(key, server))
  if (who === null) throw new Error("Devin didn't take the sign-in: nobody is signed in with the token it gave")
  const metadata = { email: who?.user || "Devin" }
  if (who?.plan) metadata.plan = who.plan
  if (server && server !== SERVER) metadata.server = server
  return { type: "success", provider: ID, key, metadata }
}

// browserSignIn is `devin auth login`'s round, run by the plugin: PKCE
// through app.devin.ai, back to a callback on 127.0.0.1.
export async function browserSignIn() {
  const verifier = randomToken(48)
  const state = randomToken(24)
  let over = false
  let settle
  const done = new Promise((r) => (settle = r))
  const finish = (result) => {
    if (over) return
    over = true
    settle(result)
  }
  let redirect = ""
  const { server } = await listenOnFirstFree([0])
  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const html = (code, body) => {
      res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" })
      res.end(body)
    }
    if (url.pathname !== "/callback") return res.writeHead(404).end()
    const q = url.searchParams
    if (over) return html(200, resultPage(false, "This sign-in is over", "Start it again."))
    if (q.get("error")) {
      const msg = q.get("error_description") || q.get("error")
      finish({ type: "failed", error: msg })
      return html(200, resultPage(false, "Sign-in didn't finish", msg))
    }
    if (q.get("state") !== state || !q.get("code")) return html(200, resultPage(false, "This link isn't from this sign-in", "Start it again."))
    try {
      const x = await exchange(q.get("code"), verifier, redirect)
      const r = await success(x.key, SERVER)
      finish(r)
      html(200, resultPage(true, "You're signed in", `${r.metadata.email} is signed in. You can close this tab.`))
    } catch (e) {
      finish({ type: "failed", error: e.message })
      html(200, resultPage(false, "Sign-in didn't finish", e.message))
    }
  })
  redirect = `http://127.0.0.1:${server.address().port}/callback`
  const timer = setTimeout(() => finish({ type: "failed", error: "the sign-in timed out" }), SIGN_IN_TIMEOUT)
  done.then(() => {
    clearTimeout(timer)
    setTimeout(() => server.close(), 5_000).unref?.()
  })
  const q = new URLSearchParams({
    redirect_uri: redirect,
    state,
    prompt: "select_account",
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
    cli_pkce_marker: "1",
  })
  return {
    url: `${AUTHORIZE}?${q}`,
    instructions: "Sign in to Devin in the browser.",
    method: "auto",
    callback: () => done,
  }
}

// cliSignIn takes the account the devin CLI is signed in to, reading its
// credentials.toml and changing nothing.
export async function cliSignIn() {
  const path = cliCredentialsPath()
  return {
    url: "",
    instructions: `Uses the account in ${path}.`,
    method: "auto",
    callback: async () => {
      try {
        const c = readCredentials(await readFile(path, "utf8"))
        if (!c.windsurf_api_key) return { type: "failed", error: `Devin isn't signed in: ${path} has no key` }
        const r = await success(c.windsurf_api_key, serverUrl(c.api_server_url, SERVER))
        r.metadata.cli = true
        return r
      } catch (e) {
        return { type: "failed", error: e?.code === "ENOENT" ? "Devin isn't signed in: run `devin auth login`" : e.message }
      }
    },
  }
}
