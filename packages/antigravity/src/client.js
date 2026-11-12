// Antigravity: what the requests say the app is — its newest version and the platform it runs on.
import { env, http, storage } from "astra"
import { FALLBACK_VERSION, VERSION_TTL, VERSION_URL } from "./constants.js"

const OS = { darwin: "darwin", win32: "windows", linux: "linux" }

let held = null // { v, at }: kept in plugin storage too, so a restarted engine does not ask the updater again

/** The newest Antigravity's version, from its updater; the last one known (else the built-in) when the updater can't say. */
export async function agentVersion(now = Date.now()) {
  if (!held) held = (await storage.get("agent-version").catch(() => null)) ?? null
  if (held && now - held.at < VERSION_TTL) return held.v
  let v = held?.v ?? FALLBACK_VERSION
  try {
    const res = await http.fetch(VERSION_URL, { headers: { "User-Agent": "electron-builder" }, timeoutMs: 3000 })
    const m = res.ok ? /^version:\s*['"]?(\d+(?:\.\d+){1,3})/m.exec(await res.text()) : null
    if (m) v = m[1]
  } catch {}
  held = { v, at: now }
  await storage.set("agent-version", held).catch(() => {})
  return v
}

/** Forgets the version asked for, so the next request asks again (tests). */
export const forgetVersion = () => {
  held = null
}

/** The User-Agent Antigravity's requests carry. The CPU is not known to a plugin: amd64 is said. */
export const userAgent = (version, os = env.platform) => `antigravity/hub/${version} ${OS[os] ?? "linux"}/amd64`
