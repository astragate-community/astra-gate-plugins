// MiniMax Code: calling the vendor — the OAuth form posts, and the signed account API.
import { createHash } from "node:crypto"
import { SIGN_SECRET } from "./constants.mjs"
import { obj, str } from "./values.mjs"

export const md5 = (s) => createHash("md5").update(s).digest("hex")

// ---- OAuth ----------------------------------------------------------------------

export class OAuthError extends Error {
  constructor(code, status, message) {
    super(message ?? `MiniMax's sign-in server said ${code}${status ? ` (HTTP ${status})` : ""}`)
    this.code = code
    this.httpStatus = status
  }
}

// postForm posts an OAuth form, as MiniMax Code's client does; ok is false
// when the answer is an HTTP error or carries an "error".
export async function postForm(url, fields) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(30000),
  })
  let body
  try {
    body = obj(JSON.parse(await res.text()))
  } catch {}
  if (!body) throw new OAuthError("invalid_json_response", res.status)
  const error = str(body, "error")
  return { ok: res.ok && !error, status: res.status, body, error }
}

// ---- MiniMax Code's signed account API -------------------------------------------

// signed is a request of MiniMax Code's account API, signed as mcode signs
// one: yy over the path and query, the body ("{}" for a GET) and the time;
// x-signature over the time (and the body of a POST).
export function signed(site, path, { access, userID, body, now = Date.now(), tz = new Date().getTimezoneOffset() * -60, platform = process.platform } = {}) {
  const url = new URL(path, site.agent)
  url.search = new URLSearchParams({
    device_platform: "mcode", biz_id: "3", app_id: "3001", version_code: "22201",
    unix: String(now), timezone_offset: String(tz), sys_language: site.lang, lang: site.lang,
    device_id: "0", os_name: platform, browser_name: "mcode", user_id: String(userID ?? "").trim() || "0", client: "mcode",
  }).toString()
  const at = url.pathname + url.search
  const ts = Math.floor(now / 1000)
  const json = body === undefined ? undefined : JSON.stringify(body)
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "MiniMaxCode",
    Authorization: "Bearer " + access,
    yy: json === undefined ? md5(`${encodeURIComponent(at)}_{}${md5(String(now))}ooui`) : md5(`${encodeURIComponent(at)}_${json}${md5(String(now))}ooui`),
    "x-timestamp": String(ts),
    "x-signature": json === undefined ? md5(`${ts}${SIGN_SECRET}`) : md5(`${ts}${SIGN_SECRET}${json}`),
  }
  return { url: url.toString(), init: { method: json === undefined ? "GET" : "POST", headers, ...(json === undefined ? {} : { body: json }) } }
}

/** The account API turned the sign-in away (HTTP 401 / 403, or status 1000048 in its body). */
export class AccountRefused extends Error {}

// checked throws on an answer MiniMax's account API says failed in its body.
export function checked(env, what) {
  const si = obj(env.statusInfo)
  if (typeof si?.code === "number" && si.code !== 0) {
    if (si.code === 1000048) throw new AccountRefused(`${what}: the sign-in was refused`)
    throw new Error(`${what}: ${str(si, "message") ?? str(si, "msg") ?? "status " + si.code}`)
  }
  const br = obj(env.base_resp)
  if (typeof br?.status_code === "number" && br.status_code !== 0) throw new Error(`${what}: ${str(br, "status_msg") ?? "status " + br.status_code}`)
  return env
}

export async function accountCall(site, path, opts, what) {
  const { url, init } = signed(site, path, opts)
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) })
  if (res.status === 401 || res.status === 403) throw new AccountRefused(`${what}: the sign-in was refused (HTTP ${res.status})`)
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)
  let env
  try {
    env = obj(JSON.parse(await res.text()))
  } catch {}
  if (!env) throw new Error(`${what}: not JSON`)
  return checked(env, what)
}

// identity is who the account is: its MiniMax user id, email and name.
export async function identity(site, access) {
  const env = await accountCall(site, "/v1/api/user/info", { access }, "account")
  const d = obj(env.data)
  const u = obj(d?.userInfo) ?? obj(d?.user_info) ?? obj(env.userInfo) ?? obj(env.user_info)
  const id = str(u, "realUserID") ?? str(u, "real_user_id")
  if (!id) throw new Error("account: no user id in the reply")
  const first = (...ks) => ks.map((k) => str(u, k)).find(Boolean)
  return { realUserID: id, email: first("userEmail", "email", "userMail", "user_email"), name: first("name", "userName", "user_name") }
}

// workspaces lists the account's workspaces from get_user_extra_info.
export async function workspaces(site, access, userID) {
  const env = await accountCall(site, "/matrix/api/v1/user/get_user_extra_info", { access, userID, body: {} }, "workspace")
  return Array.isArray(env.workspaces) ? env.workspaces : Array.isArray(env.data?.workspaces) ? env.data.workspaces : []
}

// membershipReply is get_membership_info's answer, for a workspace when one is named.
export function membershipReply(site, access, userID, body = {}) {
  return accountCall(site, "/matrix/api/v1/commerce/get_membership_info", { access, userID, body }, "membership")
}

// planRemains asks the M Plan's windows (coding_plan/remains).
export async function planRemains(site, access, group) {
  const res = await fetch(site.platform + "/v1/api/openplatform/coding_plan/remains", {
    headers: { Accept: "application/json", Authorization: "Bearer " + access, ...(group ? { "X-Group-Id": group } : {}) },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`M Plan: HTTP ${res.status}`)
  return res.json()
}
