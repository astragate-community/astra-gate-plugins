// Antigravity: what the requests say the app is — its newest version and the platform it runs on.
import { arch, platform } from "node:os"
import { FALLBACK_VERSION, VERSION_TTL, VERSION_URL } from "./constants.mjs"

const OS = { darwin: "darwin", win32: "windows", linux: "linux" }
const ARCH = { x64: "amd64", arm64: "arm64" }

let held = null // { v, at }

/** The newest Antigravity's version, from its updater; the last one known (else the built-in) when the updater can't say. */
export async function agentVersion(now = Date.now()) {
  if (held && now - held.at < VERSION_TTL) return held.v
  let v = held?.v ?? FALLBACK_VERSION
  try {
    const res = await fetch(VERSION_URL, { headers: { "User-Agent": "electron-builder" }, signal: AbortSignal.timeout(5000) })
    const m = res.ok ? /^version:\s*['"]?(\d+(?:\.\d+){1,3})/m.exec(await res.text()) : null
    if (m) v = m[1]
  } catch {}
  held = { v, at: now }
  return v
}

/** Forgets the version asked for, so the next request asks again (tests). */
export const forgetVersion = () => {
  held = null
}

/** The User-Agent Antigravity's requests carry. */
export const userAgent = (version, os = platform(), cpu = arch()) => `antigravity/hub/${version} ${OS[os] ?? "linux"}/${ARCH[cpu] ?? "amd64"}`
