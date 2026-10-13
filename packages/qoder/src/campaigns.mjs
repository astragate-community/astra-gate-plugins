// Qoder: the account's campaigns — the daily credits among them (the check-in) — asked and claimed as Qoder's
// client does, on the device token plus the device identity its own native helper reads.
import { execFile } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { API_TIMEOUT, deviceHeaders } from "./api.mjs"
import { CAMPAIGN_MACHINE_TTL } from "./constants.mjs"
import { siteOf } from "./sites.mjs"
import { errorResponse, signed, signedInError } from "./refusals.mjs"
import { bodyText } from "./util.mjs"

// CAMPAIGNS is where Qoder lists the account's campaigns — the daily
// credits among them (actionType CLAIM_BENEFIT) — and claims one
// (POST …/{id}/claim), as Qoder's client does, on the device token.
const CAMPAIGNS = "/sash/api/v1/me/campaigns"

// campaignRuntime uses Qoder's own native device identity helper, installed
// by its desktop client or cached by its CLI. A made-up token (including the
// chat envelope's machine id and type 5) doesn't reveal international claims.
//
// Where each one keeps it (Qoder desktop 0.4.3's packages, qodercli 1.1.66):
//   - desktop: <install>/resources/umid/runtime-info(.exe): Qoder.app on
//     macOS, %LOCALAPPDATA%\Programs\Qoder (the user installer) on Windows,
//     /opt/Qoder (the .deb and the .rpm) on Linux;
//   - CLI: <config>/.bin, where <config> is QODER_CONFIG_DIR, else
//     QODER_CLI_HOME (or the home folder) joined with QODER_CONFIG_DIR_NAME
//     (or .qoder): a file runtime-info-<platform>-<arch>-<hash> on macOS and
//     Linux, a folder umid-win32-<arch>-<hash> holding runtime-info.exe on
//     Windows.
export async function campaignRuntime({ home = homedir(), platform = process.platform, arch = process.arch, env = process.env, opt = "/opt" } = {}) {
  if (env.QODER_RUNTIME_INFO) return resolve(env.QODER_RUNTIME_INFO)
  const name = platform === "win32" ? "runtime-info.exe" : "runtime-info"
  const isFile = async (path) => (await stat(path).catch(() => null))?.isFile() ?? false
  const paths = []
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local")
    paths.push(join(local, "Programs", "Qoder", "resources", "umid", name))
  } else if (platform === "darwin") {
    for (const dir of ["/Applications", join(home, "Applications")]) paths.push(join(dir, "Qoder.app", "Contents", "Resources", "umid", name))
  } else if (platform === "linux") {
    paths.push(join(opt, "Qoder", "resources", "umid", name))
  }
  for (const path of paths) if (await isFile(path)) return path
  const config = env.QODER_CONFIG_DIR || join(env.QODER_CLI_HOME || env.GEMINI_CLI_HOME || home, env.QODER_CONFIG_DIR_NAME || ".qoder")
  const cache = join(config, ".bin")
  const entries = await readdir(cache, { withFileTypes: true }).catch(() => [])
  const found = []
  for (const d of entries) {
    let path
    if (platform === "win32") {
      if (d.isDirectory() && d.name.startsWith(`umid-win32-${arch}-`)) path = join(cache, d.name, name)
    } else if (d.isFile() && d.name.startsWith(`runtime-info-${platform}-${arch}-`) && !d.name.endsWith(".tmp")) {
      path = join(cache, d.name)
    }
    if (path && (await isFile(path))) found.push({ path, time: (await stat(path)).mtimeMs })
  }
  if (found.length) return found.sort((a, b) => b.time - a.time)[0].path
  throw new Error("Qoder check-in: device identity runtime not found; install Qoder desktop or sign in to Qoder CLI once, or set QODER_RUNTIME_INFO to its runtime-info executable")
}

// Read the SDK identity as Qoder does: environment 3 is international; on
// Windows and macOS the uid goes over stdin, never into the command line.
async function campaignMachine(uid) {
  if (!uid) throw new Error("Qoder check-in: device identity needs the account uid; sign in again")
  const file = await campaignRuntime()
  const args = process.platform === "linux" ? ["3"] : ["3", "--account-stdin"]
  const text = await new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 20_000, windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => {
      if (err) reject(err)
      else resolve(out)
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(process.platform === "linux" ? undefined : JSON.stringify({ account: uid }) + "\n")
  }).catch(() => {
    throw new Error("Qoder check-in: could not read device identity; restart or update Qoder, or check QODER_RUNTIME_INFO")
  })
  try {
    const identity = JSON.parse(text.trim().split(/\r?\n/, 1)[0])
    const headers = {}
    for (const [key, field] of [["Cosy-MachineToken", "machineToken"], ["Cosy-MachineType", "machineType"]]) {
      const value = identity?.[field]?.trim()
      if (!value || value.length > 4096 || !/^[\x20-\x7e]+$/.test(value)) throw new Error("invalid identity")
      headers[key] = value
    }
    return headers
  } catch {
    throw new Error("Qoder check-in: invalid device identity from Qoder; restart or update Qoder")
  }
}

// campaignPage: url is the site's campaigns page or a claim under it, which
// the account's fetch sends as the account rather than as a chat.
export function campaignPage(site, url) {
  try {
    const u = new URL(url)
    return u.origin === new URL(site.openapi).origin && (u.pathname === CAMPAIGNS || /^\/sash\/api\/v1\/me\/campaigns\/[^/]+\/claim$/.test(u.pathname))
  } catch {
    return false
  }
}

// campaignTarget is where a campaigns page url is asked for an account
// served from s: url itself on s's accounts host, or, on a VPC account, the
// same page on its instance when url names the public host (magpie's
// check-in knows only that), as Qoder CN's CLI rewrites it. null: url isn't
// one.
export function campaignTarget(base, s, url) {
  if (campaignPage(s, url)) return url
  if (s === base || !campaignPage(base, url)) return null
  const u = new URL(url)
  const to = new URL(s.openapi)
  u.protocol = to.protocol
  u.host = to.host
  return u.href
}

// campaignCall is url asked with the device token; Qoder's answer comes back
// as it is.
async function campaignCall(url, method, body, deviceToken, machine, signal) {
  return fetch(url, {
    method,
    headers: { ...deviceHeaders(deviceToken), "Content-Type": "application/json", ...machine },
    body: method === "GET" ? undefined : body || "{}",
    signal: signal ?? AbortSignal.timeout(API_TIMEOUT),
  })
}

/**
 * The fetch for a campaigns page, asked as the account: `(getAuth, input, url, init) => Response`. A refused
 * device token is rotated once, as usage does, and asked again.
 */
export function createCampaigns(site, session) {
  // The SDK identity is account-specific. Share an in-flight read, refresh
  // after an hour, and leave a failed read available for the next attempt.
  const machines = new Map()
  const machineFor = async (uid) => {
    const now = Date.now()
    let entry = machines.get(uid)
    if (!entry || now - entry.at >= CAMPAIGN_MACHINE_TTL) {
      entry = { at: now, promise: campaignMachine(uid) }
      machines.set(uid, entry)
    }
    try {
      return await entry.promise
    } catch (e) {
      if (machines.get(uid) === entry) machines.delete(uid)
      throw e
    }
  }

  return async (getAuth, input, url, init) => {
    const body = await bodyText(input, init)
    let cred
    try {
      cred = await session.fresh(getAuth)
      url = campaignTarget(site, siteOf(site, cred), url)
    } catch (e) {
      return signedInError(site, e)
    }
    if (!url) return errorResponse({ status: 404, message: "only chat completions are served" })
    const method = String(init.method ?? input?.method ?? "GET").toUpperCase()
    try {
      const machine = site.id === "qoder" ? await machineFor(cred.uid) : {}
      let res = await campaignCall(url, method, body, cred.deviceToken, machine, init.signal)
      if (res.status === 401 || res.status === 403) res = await campaignCall(url, method, body, await session.deviceToken(getAuth, cred.deviceToken), machine, init.signal)
      return signed(res, session.renewed(cred))
    } catch (e) {
      if (e?.expired) return signedInError(site, e)
      return errorResponse({ status: 502, message: e?.message ?? String(e) })
    }
  }
}
