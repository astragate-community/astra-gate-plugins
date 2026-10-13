// Trae: Trae CN's own JSON pages (the daily check-in, credits) sent as the account — what magpie's daily
// check-in (每日签到) asks through the account's fetch.
import { REQUEST_TIMEOUT } from "./constants.mjs"
import { ideHeaders } from "./api.mjs"
import { errorOf, lapsedCode } from "./errors.mjs"
import { signInOf } from "./session.mjs"

// ugUA is the User-Agent a growth page (/trae/api/v2/ug/…: the daily
// check-in) is sent with: TRAE SOLO CN's Electron shell, as its version
// is named. Bun's own (Bun/1.x) reads as a script, and Trae answers a
// script's check-in with 9074 「当前参与用户太多，请稍后再试」 however
// seldom it asks (yetone/magpie#808; qilimixingkong/trae-checkin found
// the same).
export const ugUA = (site) =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TRAE-SOLO-CN/${site.clientVersion} Chrome/120.0.6099.291 Electron/28.2.10 Safari/537.36`

// ugHeaders are the headers Trae CN's IDE (3.3.104) sends a growth page
// with, and only those: its JWT, then its device (fb: x-device-id,
// x-device-brand, x-device-type, x-os-version, x-app-version), not the
// chat's tokens and versions.
export function ugHeaders(a, site, extra = {}) {
  return {
    "Content-Type": "application/json",
    Authorization: `Cloud-IDE-JWT ${a.token}`,
    "User-Agent": ugUA(site),
    "x-device-id": a.deviceId,
    "x-device-brand": site.brand,
    "x-device-type": "Windows",
    "x-os-version": "10.0.22631",
    "x-app-version": site.clientVersion,
    ...extra,
  }
}

// ugPage: url is one of Trae's growth pages (the check-in)
export const ugPage = (url) => {
  try {
    return new URL(url).pathname.startsWith("/trae/api/v2/ug/")
  } catch {
    return false
  }
}

// ownRequest sends a request for one of Trae CN's own JSON pages as the
// account, as its IDE does: magpie asks the daily check-in
// (/trae/api/v2/ug/checkin_credits/status, then /claim) through the
// account's fetch, as it does WorkBuddy's. Trae's answer comes back as it
// is; a token it turned away (401, or code 1001 in a 200) marks the
// sign-in, as usage does.
export async function ownRequest(site, sessions, getAuth, a0, url, method, body, signal) {
  const { a, refusal } = await sessions.freshOrRefusal(getAuth, a0)
  if (refusal) return refusal
  // a growth page (the check-in) goes as the IDE sends it: its headers,
  // a client's User-Agent, and {req_source: 1} for an empty body. Every
  // check-in sent with Bun's User-Agent came back 9074, with the chat's
  // headers and {} (0.1.6, 0.1.9) as with the IDE's (0.1.7)
  // (yetone/magpie#808). Other pages go with the chat's headers.
  const ug = ugPage(url)
  let sent = method === "GET" || method === "HEAD" ? undefined : typeof body === "string" ? body : "{}"
  if (ug && sent !== undefined && /^\s*(\{\s*\})?\s*$/.test(sent)) sent = JSON.stringify({ req_source: 1 })
  const res = await fetch(url, {
    method,
    headers: ug ? ugHeaders(a, site, { Accept: "application/json" }) : ideHeaders(a, site, { Accept: "application/json" }),
    body: sent,
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT),
  })
  const text = await res.text()
  const lapsed = res.status === 401 || lapsedCode(errorOf(text).code, site)
  const headers = { "content-type": res.headers.get("content-type") ?? "application/json", "X-Magpie-Sign-In": lapsed ? "expired" : signInOf(a) }
  return new Response(text, { status: res.status, headers })
}
