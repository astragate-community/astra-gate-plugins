// The three ways to sign in: Cursor's browser login, cursor-agent's own, and an API key (plugin.mjs).
import { randomUUID } from "node:crypto"
import { challengeOf, randomToken, sleep } from "@astragate-community/plugin-kit"
import { API, CLI_MARK, WEBSITE } from "./constants.mjs"
import { cliToken, clientVersion } from "./cli.mjs"
import { whoIs } from "./api.mjs"
import { expiry } from "./jwt.mjs"

// browserSignIn is cursor-agent's `login`: the page signs in, and
// /auth/poll hands the tokens over once it has.
export async function browserSignIn() {
  const verifier = randomToken(32)
  const challenge = challengeOf(verifier)
  const uuid = randomUUID()
  const url = new URL("/loginDeepControl", WEBSITE)
  url.searchParams.set("challenge", challenge)
  url.searchParams.set("uuid", uuid)
  url.searchParams.set("mode", "login")
  url.searchParams.set("redirectTarget", "cli")
  return {
    url: url.toString(),
    instructions: "Sign in to Cursor in the browser; this finishes by itself.",
    method: "auto",
    async callback() {
      const headers = { "Content-Type": "application/json", "x-cursor-client-version": await clientVersion(), "x-cursor-client-type": "cli" }
      let errors = 0
      for (let r = 0; r < 150; r++) {
        const wait = Math.min(1000 * 1.2 ** r, 10_000)
        let res
        try {
          res = await fetch(`${API}/auth/poll?uuid=${uuid}&verifier=${verifier}`, { headers, signal: AbortSignal.timeout(15_000) })
        } catch {
          if (++errors >= 3) return { type: "failed", error: "couldn't reach Cursor" }
          await sleep(wait)
          continue
        }
        if (res.status === 404) {
          errors = 0
          await sleep(wait)
          continue
        }
        if (!res.ok) {
          if (res.status === 403 || ++errors >= 3) return { type: "failed", error: res.status === 403 ? "Cursor refused the sign-in (403)" : `Cursor's sign-in answered HTTP ${res.status}` }
          await sleep(wait)
          continue
        }
        const j = await res.json().catch(() => null)
        if (!j?.accessToken || !("refreshToken" in j)) return { type: "failed", error: "Cursor sent back no token" }
        const who = await whoIs(j.accessToken)
        return {
          type: "success",
          access: j.accessToken,
          refresh: j.refreshToken || "none",
          expires: expiry(j.accessToken) || Date.now() + 30 * 24 * 3600 * 1000,
          ...(who.email ? { accountId: who.email } : {}),
          ...(who.plan ? { plan: who.plan } : {}),
        }
      }
      return { type: "failed", error: "the sign-in timed out" }
    },
  }
}

// cliSignIn takes the account cursor-agent is signed in to; its token is
// read each time from where cursor-agent keeps it.
export async function cliSignIn() {
  return {
    url: "",
    instructions: "Uses the account `cursor-agent login` signed in to.",
    method: "auto",
    async callback() {
      const tok = await cliToken()
      const exp = expiry(tok)
      if (!tok) return { type: "failed", error: "cursor-agent isn't signed in: run `cursor-agent login`" }
      if (exp && exp <= Date.now()) return { type: "failed", error: "cursor-agent's sign-in has run out: run `cursor-agent login` again" }
      const who = await whoIs(tok)
      if (!who.email) return { type: "failed", error: "Cursor couldn't say which account is signed in" }
      return { type: "success", access: "", refresh: CLI_MARK, expires: 0, accountId: who.email, ...(who.plan ? { plan: who.plan } : {}) }
    },
  }
}
