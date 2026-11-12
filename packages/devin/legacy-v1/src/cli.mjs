// The devin CLI: finding it, running it, its credentials.toml, and reading its `auth status` report.
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, realpathSync, statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { SERVER } from "./constants.mjs"

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// cliPath finds the devin CLI, "" without one.
export function cliPath() {
  const exe = process.platform === "win32" ? "devin.exe" : "devin"
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":"))
    if (dir && isFile(join(dir, exe))) return join(dir, exe)
  for (const p of [join(homedir(), ".local", "bin", "devin"), "/usr/local/bin/devin", "/opt/homebrew/bin/devin"]) if (isFile(p)) return p
  return ""
}

// cliCredentialsPath is where the CLI keeps its own sign-in.
export function cliCredentialsPath() {
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "devin", "credentials.toml")
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "devin", "credentials.toml")
}

const tomlString = (s) => '"' + String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"'

// credentials is credentials.toml as `devin auth login` writes it.
export function credentials(key, server, webapp, api) {
  return [
    ["windsurf_api_key", key],
    ["api_server_url", server || SERVER],
    ["devin_webapp_host", webapp || "app.devin.ai"],
    ["devin_api_url", api || "https://api.devin.ai"],
  ]
    .map(([k, v]) => `${k} = ${tomlString(v)}\n`)
    .join("")
}

// readCredentials reads the keys of a credentials.toml the CLI wrote.
export function readCredentials(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*$/.exec(line)
    if (m) out[m[1]] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]
  }
  return out
}

// homeFor is a data folder of this plugin's own, laid out as the CLI's,
// with the account's credentials in it: the CLI run with it as its data
// folder answers for that account, and its own sign-in is never touched.
export async function homeFor(key, server) {
  const base = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode-devin-auth")
  const home = join(base, createHash("sha256").update(key).digest("hex").slice(0, 16))
  const file = join(home, "devin", "credentials.toml")
  if (!existsSync(file)) {
    await mkdir(join(home, "devin"), { recursive: true, mode: 0o700 })
    await writeFile(file, credentials(key, server), { mode: 0o600 })
  }
  return home
}

// runCLI runs the devin CLI, for the account in home ("" for its own),
// with its output; it asks Devin's servers, so it has 30 seconds.
export function runCLI(home, ...args) {
  const path = cliPath()
  if (!path) return Promise.reject(new Error("devin is not installed"))
  const env = { ...process.env }
  if (home) {
    for (const k of Object.keys(env)) if (["XDG_DATA_HOME", "APPDATA"].includes(k.toUpperCase())) delete env[k]
    env.XDG_DATA_HOME = home
    env.APPDATA = home
  }
  return new Promise((resolve, reject) => {
    const p = spawn(path, args, { env, stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    p.stdout.on("data", (b) => (out += b))
    const timer = setTimeout(() => p.kill(), 30_000)
    p.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    p.on("close", (code) => {
      clearTimeout(timer)
      resolve({ out, code })
    })
  })
}

// signedOut says the CLI's report is one of nobody signed in: it says so,
// or Devin's servers refused the account's token.
export const signedOut = (out) => ["Not logged in", "Authentication required", "Invalid token", "try logging out and logging in again"].some((s) => out.includes(s))

// statusField is a field of `devin auth status`'s report, "" without it.
function statusField(out, key) {
  for (const l of out.split(/\r?\n/)) {
    const t = l.trim()
    if (t.startsWith(key + ":")) return t.slice(key.length + 1).trim()
  }
  return ""
}

// parseStatus reads `devin auth status`'s report: its User's Email (or
// Name), its Account's Tier (or Plan).
export function parseStatus(out) {
  if (!out.includes("Logged in")) return null
  return { user: statusField(out, "Email") || statusField(out, "Name"), plan: statusField(out, "Tier") || statusField(out, "Plan") }
}

// inside says file is in dir, whichever way either is spelled.
function inside(file, dir) {
  const real = (p) => {
    let r
    try {
      r = realpathSync(p)
    } catch {
      r = resolve(p)
    }
    return process.platform === "win32" ? r.toLowerCase() : r
  }
  const rel = relative(real(dir), real(file))
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

// readsHome says the CLI's report is of the credentials.toml in home: the
// devin CLI on Windows reads %APPDATA%\devin\ whatever APPDATA it is run
// with (#17), and so answers for its own account, not home's. A report that
// names no file is taken at its word.
export function readsHome(out, home) {
  const file = statusField(out, "File")
  return !home || !file || inside(file, home)
}
