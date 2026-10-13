// cursor-agent on this machine: its executable, its version, and the token it keeps.
import { readFile, readdir, realpath, stat } from "node:fs/promises"
import { execFile } from "node:child_process"
import { GOOS, SOON, VERSION_FALLBACK } from "./constants.mjs"
import { basename, dirname, join } from "node:path"
import { homedir } from "node:os"
import { expiry } from "./jwt.mjs"
import { AuthError } from "./errors.mjs"

const exists = (p) => stat(p).then((s) => !s.isDirectory(), () => false)

export function run(file, args, { timeout = 10_000, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, env: env ?? process.env, maxBuffer: 8 << 20 }, (err, stdout) =>
      resolve({ ok: !err, out: String(stdout ?? "") }))
  })
}

// cursorExecutable finds the cursor-agent CLI, or Cursor's `agent` by that
// name.
async function cursorExecutable() {
  const dirs = (process.env.PATH ?? "").split(GOOS === "windows" ? ";" : ":").filter(Boolean)
  for (const name of ["cursor-agent", "agent"]) {
    for (const d of dirs) {
      const p = join(d, GOOS === "windows" ? name + ".exe" : name)
      if (!(await exists(p))) continue
      if (name === "cursor-agent") return p
      if ((await realpath(p).catch(() => "")).includes("cursor-agent")) return p
    }
  }
  const home = homedir()
  for (const p of [join(home, ".local", "bin", "cursor-agent"), "/usr/local/bin/cursor-agent", "/opt/homebrew/bin/cursor-agent"])
    if (await exists(p)) return p
  return ""
}

const VERSION_RE = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/

// clientVersion is the cursor-agent the API is told it is talking to,
// "cli-<version>": the installed one, as the API turns away a version it no
// longer supports.
const clientState = { said: "" }
export async function clientVersion() {
  if (clientState.said) return clientState.said
  let v = ""
  const exe = await cursorExecutable()
  if (exe) {
    const d = basename(dirname(await realpath(exe).catch(() => exe)))
    if (VERSION_RE.test(d)) v = d
  }
  if (!v) {
    const dirs = [join(homedir(), ".local", "share", "cursor-agent", "versions")]
    if (GOOS === "windows") dirs.push(join(process.env.LOCALAPPDATA ?? "", "cursor-agent", "versions"))
    for (const dir of dirs)
      for (const n of await readdir(dir).catch(() => [])) if (VERSION_RE.test(n) && n > v) v = n
  }
  clientState.said = "cli-" + (v || VERSION_FALLBACK)
  return clientState.said
}

// authFile is where cursor-agent keeps its sign-in off a Mac's keychain.
function authFile() {
  const home = homedir()
  if (GOOS === "windows") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "auth.json")
  if (GOOS === "darwin") return join(home, ".cursor", "auth.json")
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "cursor", "auth.json")
}

// cliToken is the access token cursor-agent signed in with; read, never
// written.
export async function cliToken() {
  if (GOOS === "darwin") {
    const r = await run("security", ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"])
    if (r.ok && r.out.trim()) return r.out.trim()
  }
  try {
    return JSON.parse(await readFile(authFile(), "utf8"))?.accessToken ?? ""
  } catch {
    return ""
  }
}

// cliTokenNow is cursor-agent's token; one about to run out is renewed by
// cursor-agent, which does that whenever it runs.
const cliRefresh = { running: null }
export async function cliTokenNow() {
  let tok = await cliToken()
  const exp = expiry(tok)
  if (tok && (!exp || exp - Date.now() > SOON)) return tok
  const exe = await cursorExecutable()
  if (exe) {
    cliRefresh.running ??= run(exe, ["status"], { timeout: 30_000 }).finally(() => (cliRefresh.running = null))
    await cliRefresh.running
    tok = await cliToken()
  }
  // the built-in's words (provider.CursorToken)
  if (!tok) throw new AuthError("Cursor isn't signed in; sign in from magpie's Providers page or run `cursor-agent login`")
  const e = expiry(tok)
  if (e && e <= Date.now()) throw new AuthError("Cursor's sign-in has run out; sign in again from magpie's Providers page or run `cursor-agent login`")
  return tok
}
