// How Zed turns a request away: the error it is thrown as, the message in its body, the status it stands for.
import { STATUS_CODES } from "node:http"
import { parse } from "./json.mjs"

export class ZedStatus extends Error {
  constructor(status, body, headers) {
    super(`Zed: ${failure(status, body)} (${status})`)
    this.status = status
    this.body = body
    this.headers = headers
  }
}

// SignInExpired is Zed refusing the account's own sign-in (a 401 for its
// model token): the one failure the built-in marked the account lapsed for
// (zedLapse).
export class SignInExpired extends Error {}

// failure is the message in an error body: {code, message}, else the body
// itself, else the status's name.
export function failure(status, body) {
  const j = parse(body)
  if (j && typeof j === "object") {
    if (j.message) return String(j.message)
    if (typeof j.error === "string" && j.error) return j.error
    if (j.code) return String(j.code)
  }
  const s = String(body ?? "").trim()
  if (s && s.length < 500) return s
  if (status === 402) return "payment required: this Zed account has no plan that calls models, or its allowance is used up"
  return STATUS_CODES[status] ?? String(status)
}

// failedStatus is the HTTP status a failure's code stands for:
// upstream_http_<n> or http_<n>, else what the code names.
export function failedStatus(code) {
  code = String(code ?? "")
  for (const p of ["upstream_http_", "http_"]) {
    if (code.startsWith(p)) {
      const n = Number(code.slice(p.length))
      if (Number.isInteger(n)) return n
    }
  }
  if (code.includes("rate_limit")) return 429
  if (code.includes("overloaded")) return 529
  if (code.includes("billing") || code.includes("payment")) return 402
  if (code.includes("context_length")) return 400
  return 502
}

/** failedStatus, but a status that isn't an error one is a 502. */
export function errorStatusOf(code) {
  const n = failedStatus(code)
  return n >= 400 && n <= 599 ? n : 502
}

// refusal is the status and message for a request Zed turned away: its
// {code, message, upstream_status}, a 402 as the plan it is.
export function refusal(status, body) {
  if (status === 402) return [402, "payment required — this account's plan doesn't include Zed's hosted models, or its allowance is used up (see zed.dev/account)"]
  // a model token refused right after it was minted: the account's own
  // sign-in just worked, so the built-in answered 401 without marking it
  // (errorResponse says kept)
  if (status === 401) return [401, "the sign-in was refused — sign in again"]
  const j = parse(body) ?? {}
  let code = status
  const up = Number(j.upstream_status)
  if (up >= 400 && up <= 599) code = up
  else if (j.code) {
    const n = failedStatus(j.code)
    if (n !== 502) code = n
  }
  if (code < 400 || code > 599) code = 502
  let msg = failure(status, body)
  if (Number(j.retry_after) > 0) msg += ` (retry after ${Number(j.retry_after)}s)`
  return [code, msg]
}

// stale says a model request was turned away for its model token, which a
// new one would fix.
export const stale = (status, headers) => status === 401 || !!headers.get("x-zed-expired-token") || !!headers.get("x-zed-outdated-token")
