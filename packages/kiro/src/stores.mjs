// Kiro: where Kiro's own apps keep their sign-in (kiro-cli's SQLite database, the IDE's token file), read from
// there each time and, once refreshed here, written back.
import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { BUILDER_ID_START, isBuilderID } from "./constants.mjs"
import { tryJSON } from "./errors.mjs"

const env = (k) => process.env[k] ?? ""
const home = () => env("HOME") || homedir()

export function cliDB() {
  if (process.platform === "win32") return join(env("APPDATA") || join(home(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3")
  if (process.platform === "darwin") return join(home(), "Library", "Application Support", "kiro-cli", "data.sqlite3")
  return join(home(), ".local", "share", "kiro-cli", "data.sqlite3")
}
export const ideDir = () => join(home(), ".aws", "sso", "cache")

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// kiroExecutable finds kiro-cli, which refreshes its own sign-in.
export function kiroExecutable() {
  for (const d of env("PATH").split(delimiter)) {
    const p = join(d, process.platform === "win32" ? "kiro-cli.exe" : "kiro-cli")
    if (d && isFile(p)) return p
  }
  for (const p of [join(home(), ".local", "bin", "kiro-cli"), "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli",
    "/usr/local/bin/kiro-cli", "/opt/homebrew/bin/kiro-cli"])
    if (isFile(p)) return p
  return ""
}

/** Has kiro-cli refresh its own token (it writes the database; the caller reads it again). */
export const runKiroRefresh = (bin) =>
  new Promise((resolve) => execFile(bin, ["debug", "refresh-auth-token"], { timeout: 20_000 }, () => resolve()))

// openDB opens kiro-cli's SQLite database, with Bun's driver or Node's.
async function openDB(path, readonly) {
  try {
    const { Database } = await import("bun:sqlite")
    return new Database(path, readonly ? { readonly: true } : { readwrite: true })
  } catch (e) {
    if (typeof Bun !== "undefined") throw e
  }
  const { DatabaseSync } = await import("node:sqlite")
  return new DatabaseSync(path, { readOnly: readonly })
}

const time = (s) => {
  const t = Date.parse(s ?? "")
  return Number.isFinite(t) ? t : 0
}

// cliCred is a kiro-cli token row (kind: social, odic, external-idp) as the plugin's sign-in.
function cliCred(kind, m, key, get) {
  const c = { access: m.access_token, refresh: m.refresh_token ?? "", expires: time(m.expires_at), region: m.region || "us-east-1",
    profile: m.profile_arn ?? "", dbKey: key }
  if (kind === "social") c.method = "social"
  else if (kind === "odic") {
    c.method = "idc"
    // as kiro-cli tells them apart: Builder ID's start URL, or none
    c.builderID = !m.start_url || m.start_url === BUILDER_ID_START
    const reg = get("kirocli:odic:device-registration")
    if (reg) [c.clientId, c.clientSecret] = [reg.client_id ?? "", reg.client_secret ?? ""]
  } else {
    c.method = "external-idp"
    c.clientId = m.client_id ?? ""
    c.tokenURL = m.token_endpoint || (m.issuer_url ? m.issuer_url.replace(/\/$/, "") + "/v1/token" : "")
  }
  return c
}

// readCLI reads kiro-cli's sign-in: with Google or GitHub, with AWS (Builder
// ID, IAM Identity Center), or with a company's own identity provider.
export async function readCLI() {
  const path = cliDB()
  if (!existsSync(path)) return null
  let db
  try {
    db = await openDB(path, true)
    const get = (key) => {
      const row = db.prepare("SELECT value FROM auth_kv WHERE key = ?").get(key)
      return row?.value ? tryJSON(row.value) : null
    }
    for (const kind of ["social", "odic", "external-idp"]) {
      const key = `kirocli:${kind}:token`
      const m = get(key)
      if (m?.access_token) return cliCred(kind, m, key, get)
    }
  } catch {
  } finally {
    db?.close()
  }
  return null
}

// readIDE reads the Kiro IDE's sign-in.
export async function readIDE() {
  const path = join(ideDir(), "kiro-auth-token.json")
  let t
  try {
    t = JSON.parse(await readFile(path, "utf8"))
  } catch {
    return null
  }
  if (!t?.accessToken) return null
  const c = { access: t.accessToken, refresh: t.refreshToken ?? "", expires: time(t.expiresAt), region: t.region || "us-east-1",
    profile: t.profileArn ?? "", method: "idc", idePath: path, builderID: isBuilderID(t.provider) }
  if (t.clientIdHash) {
    try {
      const reg = JSON.parse(await readFile(join(ideDir(), t.clientIdHash + ".json"), "utf8"))
      ;[c.clientId, c.clientSecret] = [reg.clientId ?? "", reg.clientSecret ?? ""]
    } catch {}
  }
  if (String(t.authMethod).toLowerCase() === "social" || !c.clientId) c.method = "social"
  return c
}

// saveBack writes a refreshed token back where it was read from, so
// kiro-cli or the IDE goes on with it (a refresh may replace the refresh
// token).
export async function saveBack(c) {
  const expires = new Date(c.expires).toISOString()
  if (c.dbKey) {
    let db
    try {
      db = await openDB(cliDB(), false)
      db.exec("PRAGMA busy_timeout = 3000")
      const row = db.prepare("SELECT value FROM auth_kv WHERE key = ?").get(c.dbKey)
      if (!row?.value) return
      const m = JSON.parse(row.value)
      Object.assign(m, { access_token: c.access, refresh_token: c.refresh, expires_at: expires })
      if (c.profile && c.method === "social") m.profile_arn = c.profile
      db.prepare("UPDATE auth_kv SET value = ? WHERE key = ?").run(JSON.stringify(m), c.dbKey)
    } catch {
    } finally {
      db?.close()
    }
  } else if (c.idePath) {
    try {
      const m = JSON.parse(await readFile(c.idePath, "utf8"))
      Object.assign(m, { accessToken: c.access, refreshToken: c.refresh, expiresAt: expires })
      await writeFile(c.idePath + ".magpie-tmp", JSON.stringify(m, null, 2), { mode: 0o600 })
      await rename(c.idePath + ".magpie-tmp", c.idePath)
    } catch {}
  }
}
