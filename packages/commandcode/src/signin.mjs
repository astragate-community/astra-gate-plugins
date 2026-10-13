// Signing in: the browser flow (Studio approves a key and posts it back), the CLI's own sign-in, and the key an
// account has now
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { listenOnFirstFree, randomToken, resultPage, sleep } from "@astragate-community/plugin-kit"
import { ID, ORIGINS, SIGN_IN_TIMEOUT, STUDIO } from "./constants.mjs"
import { accountJSON, subsSeen, subscriptionOf } from "./account.mjs"

// where Command Code's CLI keeps its sign-in
const cliAuthPath = () => join(homedir(), ".commandcode", "auth.json")

// signedIn names a new key's account with whoami and reads its plan. Only
// whoami turning the key down (401, 403) fails: it has answered a key just
// made with a 500, so one that errs is asked again a few times, then
// passed over for the name Studio sent with the key.
async function signedIn(a) {
  let me
  for (let tries = 0; ; tries++) {
    try {
      me = (await accountJSON("/alpha/whoami", a.apiKey))?.user
      break
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw new Error("Command Code didn't take the new key")
      if (tries >= 2) break
      await sleep(1000)
    }
  }
  const who = me?.userName || a.userName || me?.email || me?.id || a.userId || "Command Code"
  const sub = await subscriptionOf(a.apiKey, 30_000)
  if (sub) subsSeen.set(a.apiKey, { sub, at: Date.now() })
  const plan = sub?.plan ?? ""
  return { who, plan, email: me?.email ?? "" }
}

// success is what a sign-in gives OpenCode: the key, and who it is.
async function success(a) {
  const { who, plan } = await signedIn(a)
  const metadata = { email: who }
  if (a.userId) metadata.userId = a.userId
  if (a.keyName) metadata.keyName = a.keyName
  if (plan) metadata.plan = plan
  return { type: "success", provider: ID, key: a.apiKey, metadata }
}

// browserSignIn is the CLI's: Studio asks the user to approve a key for
// this machine, then posts it (a form, or JSON from an older Studio) to
// the callback, which sends the browser on to a page saying how it went.
export async function browserSignIn() {
  const state = randomToken(24)
  let status = { state: "waiting" }
  let settle
  const done = new Promise((r) => (settle = r))
  const finish = (st, result) => {
    if (status.state !== "waiting") return
    status = st
    settle(result)
  }
  const fail = (error) => finish({ state: "failed", error }, { type: "failed", error })

  const handle = async (req, res) => {
    const origin = ORIGINS.includes(req.headers.origin) ? req.headers.origin : ORIGINS[0]
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (req.headers["access-control-request-private-network"] === "true") res.setHeader("Access-Control-Allow-Private-Network", "true")
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname
    const html = (code, body) => {
      res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" })
      res.end(body)
    }
    if (req.method === "OPTIONS") return res.writeHead(204).end()
    if (path === "/callback/complete" && req.method === "GET") {
      return status.state === "done"
        ? html(200, resultPage(true, "You're signed in", `${status.who} is signed in. You can close this tab.`))
        : html(200, resultPage(false, "Sign-in didn't finish", status.error || "Start it again."))
    }
    if (path === "/cancel") {
      finish({ state: "canceled" }, { type: "failed", error: "the sign-in was canceled" })
      return res.writeHead(204).end()
    }
    if (path !== "/callback") return res.writeHead(404).end()
    if (req.method !== "POST") return res.writeHead(405).end()

    let raw = ""
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 10_000) break
    }
    const isJSON = String(req.headers["content-type"] ?? "").trim().toLowerCase().startsWith("application/json")
    let got = {}
    if (isJSON) {
      try {
        got = JSON.parse(raw) ?? {}
      } catch {}
    } else got = Object.fromEntries(new URLSearchParams(raw))
    const answer = (ok, msg) => {
      if (isJSON) {
        res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ success: ok, error: msg }))
      }
      res.writeHead(303, { Location: "/callback/complete?state=" + encodeURIComponent(got.state ?? ""), "Cache-Control": "no-store" })
      res.end()
    }
    if (got.state !== state) return html(403, resultPage(false, "This link isn't from this sign-in", "Start it again."))
    if (status.state !== "waiting") return answer(false, "this sign-in is over")
    if (got.error) {
      const msg = got.error === "access_denied" ? "the sign-in was denied" : got.error_description || got.error
      fail(msg)
      return answer(false, msg)
    }
    if (!got.apiKey) return answer(false, "Command Code sent back no key")
    try {
      const r = await success({ apiKey: got.apiKey, userId: got.userId, userName: got.userName, keyName: got.keyName })
      finish({ state: "done", who: r.metadata.email }, r)
      answer(true, "")
    } catch (e) {
      fail(e.message)
      answer(false, e.message)
    }
  }
  // any free port: the callback is on 127.0.0.1 only
  const { server } = await listenOnFirstFree([0])
  server.on("request", handle)
  const port = server.address().port
  const timer = setTimeout(() => fail("the sign-in timed out"), SIGN_IN_TIMEOUT)
  // the browser comes back for its page after the key: the server stays
  // up a while for it
  done.then(() => {
    clearTimeout(timer)
    setTimeout(() => server.close(), 10_000).unref?.()
  })
  const q = new URLSearchParams({ callback: `http://127.0.0.1:${port}/callback`, state, mode: "redirect" })
  return {
    url: `${STUDIO}/studio/auth/cli?${q}`,
    instructions: "Approve the key for this machine in Command Code Studio.",
    method: "auto",
    callback: () => done,
  }
}

// cliSignIn takes the account Command Code's CLI is signed in to, reading
// ~/.commandcode/auth.json and changing nothing.
export async function cliSignIn() {
  const path = cliAuthPath()
  return {
    url: "",
    instructions: `Uses the account in ${path}.`,
    method: "auto",
    callback: async () => {
      try {
        const a = JSON.parse(await readFile(path, "utf8"))
        if (!String(a?.apiKey ?? "").trim()) return { type: "failed", error: `Command Code's CLI isn't signed in: ${path} has no key` }
        const r = await success(a)
        r.metadata.cli = true
        return r
      } catch (e) {
        return { type: "failed", error: e?.code === "ENOENT" ? "Command Code's CLI isn't signed in: run `commandcode login`" : e instanceof SyntaxError ? `${path} can't be read` : e.message }
      }
    },
  }
}

// liveKey is the key an account has now: one taken from the CLI's sign-in
// reads the CLI's again, as a `commandcode login` since may have changed
// it, and keeps the one it was saved with while the CLI has none.
export async function liveKey(auth) {
  if (!auth?.metadata?.cli) return auth?.key
  try {
    const a = JSON.parse(await readFile(cliAuthPath(), "utf8"))
    const k = String(a?.apiKey ?? "").trim()
    if (k) return k
  } catch {}
  return auth.key
}
