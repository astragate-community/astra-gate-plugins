// Signing in: the CLI's device-code login, the sign-in it already has, and a CPA account file imported.
import { spawn } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { sleep } from "@astragate-community/plugin-kit"
import { CPA_CLIENT_ID, CPA_SCOPE, LINK_WAIT } from "./constants.mjs"
import { cliHome, credential, envFor, isFile, newHome, requireExecutable } from "./cli.mjs"
import { token } from "./session.mjs"

// eslint-disable-next-line no-control-regex -- the escape character is what terminal colouring starts with
const ANSI =/\x1b\[[0-9;?]*[A-Za-z]/g
const LINK = /https:\/\/\S+/

// linkIn is the page a line of `grok login` gives to open, "" for none: a
// line saying it failed names the endpoint it couldn't reach (`Error: error
// sending request for url (https://auth.x.ai/oauth2/device/code): …`),
// which is no page to open.
export const linkIn = (line) => (/\berror\b/i.test(line) ? "" : (line.match(LINK)?.[0] ?? ""))

// login runs `grok login --device-auth` in home and hands on the first link
// it prints; done is settled when the command is.
function login(exe, home, own) {
  const child = spawn(exe, ["login", "--device-auth"], {
    cwd: homedir(),
    env: own ? envFor(home) : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const tail = []
  let buf = ""
  let found
  const link = new Promise((resolve) => (found = resolve))
  const onData = (chunk) => {
    buf += chunk.toString()
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "").replace(ANSI, "").trim()
      buf = buf.slice(i + 1)
      if (line) tail.push(line)
      const u = linkIn(line)
      if (u) found(u)
    }
  }
  child.stdout.on("data", onData)
  child.stderr.on("data", onData)
  const done = new Promise((resolve) => {
    child.on("error", (e) => {
      tail.push(e.message)
      found("")
      resolve({ ok: false, why: e.message })
    })
    child.on("close", (code) => {
      const rest = buf.replace(ANSI, "").trim()
      if (rest) {
        tail.push(rest)
        const u = linkIn(rest)
        if (u) found(u)
      }
      found("")
      resolve({ ok: code === 0, why: tail.at(-1) ?? "grok login didn't finish" })
    })
  })
  return { child, link, done, tail }
}

// saved is the sign-in as OpenCode keeps it: refresh is the home the CLI
// keeps it in, access the token it had then.
export function saved(home, c) {
  return { type: "success", refresh: home, access: c.key, expires: c.expires, accountId: c.email }
}

// signIn signs in with the CLI's device code: in the CLI's own home when
// that isn't signed in, else in a home of this plugin's, so the CLI's own
// sign-in stays as it is.
export async function signIn() {
  const exe = requireExecutable()
  const own = !!credential(cliHome())
  const home = own ? newHome() : cliHome()
  const { child, link, done, tail } = login(exe, home, own)
  const url = await Promise.race([link, sleep(LINK_WAIT).then(() => "")])
  if (!url) {
    child.kill()
    if (own) rmSync(home, { recursive: true, force: true })
    // what it said last is why: where x.ai is out of reach without a
    // proxy, it says it couldn't reach it (𝕏 on Discord)
    const why = tail.at(-1)
    throw new Error(why ? `grok login gave no link to open: ${why}` : "grok login gave no link to open and said nothing: can this machine reach auth.x.ai? Set a proxy in magpie's Settings if it needs one")
  }
  return {
    url,
    instructions: "Approve the sign-in on the page; Grok Build finishes it.",
    method: "auto",
    callback: async () => {
      const r = await done
      const c = r.ok ? credential(home) : null
      if (!c || (own && !c.email)) {
        if (own) rmSync(home, { recursive: true, force: true })
        return { type: "failed", error: r.ok ? "grok login finished without an account" : r.why }
      }
      return saved(home, c)
    },
  }
}

// current takes the sign-in the CLI already has, as it is.
export async function current() {
  requireExecutable()
  const home = cliHome()
  if (!credential(home)) throw new Error("Grok Build is not signed in; run `grok login`, or sign in with the device code")
  const c = await token(home, false)
  return {
    url: "",
    instructions: c.email ? `Grok Build is signed in as ${c.email}.` : "Grok Build is signed in.",
    method: "auto",
    callback: async () => saved(home, c),
  }
}

// ---- CPA (CLIProxyAPI) account files -------------------------------------------

function cpaClaims(token) {
  try {
    const part = token.split(".")[1]
    if (!part) return null
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
  } catch {
    return null
  }
}

const filled = (v) => typeof v === "string" && v !== ""

// cpaAuth is an xAI OAuth account from a CPA file as the CLI keeps it in auth.json; it throws for a file that
// is not one.
export function cpaAuth(source) {
  if (!source || typeof source !== "object" || Array.isArray(source) || source.type !== "xai" || source.auth_kind !== "oauth" || source.disabled !== false) {
    throw new Error("CPA file is not an enabled xAI OAuth account")
  }
  if (![source.access_token, source.refresh_token, source.sub, source.email].every(filled)) {
    throw new Error("CPA xAI account is missing its tokens or identity")
  }
  if (typeof source.last_refresh !== "string" || typeof source.expired !== "string") {
    throw new Error("CPA xAI account has invalid token timestamps")
  }
  const createTime = Date.parse(source.last_refresh)
  const expiresAt = Date.parse(source.expired)
  if (!Number.isFinite(createTime) || !Number.isFinite(expiresAt)) {
    throw new Error("CPA xAI account has invalid token timestamps")
  }
  const claims = cpaClaims(source.access_token)
  const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud]
  if (claims?.iss !== "https://auth.x.ai" || !audience.includes(CPA_CLIENT_ID)) {
    throw new Error("CPA token is not for the Grok Build xAI account")
  }
  return {
    key: source.access_token,
    auth_mode: "oidc",
    create_time: new Date(createTime).toISOString(),
    user_id: source.sub,
    email: source.email,
    refresh_token: source.refresh_token,
    expires_at: new Date(expiresAt).toISOString(),
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: CPA_CLIENT_ID,
  }
}

function cpaAuthFromFile(file) {
  let source
  try {
    source = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    throw new Error("CPA Grok account file is not valid JSON")
  }
  return cpaAuth(source)
}

export async function importCPA(inputs) {
  requireExecutable()
  const rawPath = String(inputs?.path ?? "").trim()
  const file = resolve(rawPath === "~" ? homedir() : rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : rawPath)
  if (!isFile(file)) throw new Error("choose a CPA Grok account JSON file")
  const auth = cpaAuthFromFile(file)
  return {
    url: "",
    instructions: "The account is ready to import. Stop using it in CPA before continuing; both clients rotate the same refresh token.",
    method: "auto",
    callback: async () => {
      const home = newHome()
      try {
        writeFileSync(join(home, "auth.json"), JSON.stringify({ [CPA_SCOPE]: auth }, null, 2), { mode: 0o600 })
      } catch (error) {
        rmSync(home, { recursive: true, force: true })
        throw error
      }
      return saved(home, credential(home))
    },
  }
}
