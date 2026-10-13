// The Grok Build CLI on this machine: where it and its sign-in live, and running it.
import { execFile } from "node:child_process"
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"
import { randomToken } from "@astragate-community/plugin-kit"
import { INSTALL } from "./constants.mjs"

// cliHome is where the CLI keeps its own sign-in and settings.
export function cliHome() {
  return process.env.GROK_HOME || join(homedir(), ".grok")
}

// ownHomes is where this plugin keeps a sign-in made beside the CLI's own.
function ownHomes() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode-grok-auth")
}

export function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// isGrokBuild tells xAI's grok from any other program by that name: its
// installer keeps it under the grok home.
function isGrokBuild(p) {
  let real = p
  try {
    real = realpathSync(p)
  } catch {}
  return real.replaceAll("\\", "/").toLowerCase().includes("/.grok/")
}

// executable finds the CLI, first to last: the installer's bin
// (GROK_BIN_DIR, GROK_HOME/bin, ~/.grok/bin), each folder on PATH, then
// ~/.local/bin; those two only when it is really Grok Build.
export function executable() {
  const name = process.platform === "win32" ? "grok.exe" : "grok"
  const home = homedir()
  const seen = new Set()
  const out = []
  const add = (dir, own) => {
    if (!dir || !isAbsolute(dir)) return
    const p = join(dir, name)
    const k = process.platform === "win32" ? p.toLowerCase() : p
    if (seen.has(k)) return
    seen.add(k)
    out.push({ p, own })
  }
  add(process.env.GROK_BIN_DIR, true)
  add(join(cliHome(), "bin"), true)
  if (home) add(join(home, ".grok", "bin"), true)
  for (const d of (process.env.PATH ?? "").split(delimiter)) add(d.trim(), false)
  if (home) add(join(home, ".local", "bin"), false)
  for (const c of out) if (isFile(c.p) && (c.own || isGrokBuild(c.p))) return c.p
  return ""
}

// requireExecutable is the CLI's path, or an error saying how to install it.
export function requireExecutable() {
  const exe = executable()
  if (!exe) throw new Error(`install Grok Build first: ${INSTALL}`)
  return exe
}

// envFor runs the CLI as the user runs it, in the given home.
export function envFor(home) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (["GROK_HOME", "GROK_AUTH_PROVIDER_COMMAND", "GROK_AUTH_EXPIRED"].includes(k.toUpperCase())) continue
    env[k] = v
  }
  env.GROK_HOME = home
  return env
}

// credential is the sign-in the CLI keeps in home: the first, by key, with a token.
export function credential(home) {
  let all
  try {
    all = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"))
  } catch {
    return null
  }
  if (!all || typeof all !== "object") return null
  for (const k of Object.keys(all).sort()) {
    const c = all[k]
    if (c && typeof c.key === "string" && c.key) {
      const t = Date.parse(c.expires_at ?? "")
      return { key: c.key, email: c.email ?? "", expires: Number.isFinite(t) ? t : 0, issuer: c.oidc_issuer ?? "" }
    }
  }
  return null
}

export function run(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 30000, ...opts }, (err, stdout) => resolve({ err, stdout: String(stdout ?? "") }))
  })
}

// newHome makes a home of this plugin's own for one more sign-in.
export function newHome() {
  const home = join(ownHomes(), randomToken(9).replace(/[-_]/g, "").toLowerCase())
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return home
}
