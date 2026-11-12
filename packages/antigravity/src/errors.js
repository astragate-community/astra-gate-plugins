// Antigravity: reading what Code Assist answers with when it refuses, and the errors this plugin throws.

/** JSON.parse that gives null for text that isn't JSON. */
export function tryJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// Google's words for an HTTP status (Go's http.StatusText, as the other plugins say them)
const STATUS_TEXT = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 408: "Request Timeout", 409: "Conflict",
  413: "Request Entity Too Large", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
  504: "Gateway Timeout" }
export const statusWords = (status) => STATUS_TEXT[status] ?? ""

// "3.5s", "0.201506475s", "4m50s", "200ms": how long Google says to wait, in ms; 0 for words that aren't one
export function durationMs(text) {
  if (typeof text !== "string") return 0
  let total = 0
  let any = false
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    any = true
    total += Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]]
  }
  return any ? Math.round(total) : 0
}

/**
 * What a refusal from Code Assist says, once read: `message` (Google's own words), `status` (HTTP), and `kind`:
 *  - "validation": the account must verify itself first (`url` is where);
 *  - "violation": Google says the account broke its terms of service;
 *  - "forbidden": any other 403;
 *  - "limit": a rate limit of the account's model, `waitMs` is how long it lasts;
 *  - "capacity": the model has no room for anyone just now, `waitMs` is how long to wait;
 *  - "busy": a limit of the host that answered ("Resource has been exhausted"), which another host may not have;
 *  - "auth": a token Google turned down;
 *  - "other".
 */
export function describe(status, text) {
  const body = tryJSON(text)
  const e = body?.error ?? body?.[0]?.error ?? {}
  const details = Array.isArray(e.details) ? e.details : []
  const info = details.find((d) => d?.["@type"]?.endsWith("google.rpc.ErrorInfo")) ?? {}
  const retry = details.find((d) => d?.["@type"]?.endsWith("google.rpc.RetryInfo"))
  const message = String(e.message ?? "").trim() || (body ? "" : String(text ?? "").trim().slice(0, 500)) || statusWords(status)
  const reason = String(info.reason ?? "")
  const lower = (message + " " + String(text ?? "")).toLowerCase()
  const out = { status, message, reason, model: info.metadata?.model ?? "", waitMs: durationMs(retry?.retryDelay) || durationMs(info.metadata?.quotaResetDelay), kind: "other", url: "" }
  if (status === 401 || e.status === "UNAUTHENTICATED") out.kind = "auth"
  else if (status === 403) {
    const url = details.map((d) => d?.metadata?.validation_url || d?.metadata?.appeal_url).find(Boolean) ?? ""
    out.url = url
    if (reason === "VALIDATION_REQUIRED" || lower.includes("validation_required") || lower.includes("verify your account") || url) out.kind = "validation"
    else if (lower.includes("terms of service") || lower.includes("violation")) out.kind = "violation"
    else out.kind = "forbidden"
  } else if (reason === "MODEL_CAPACITY_EXHAUSTED" || (status === 503 && e.status === "UNAVAILABLE" && lower.includes("capacity"))) out.kind = "capacity"
  else if (status === 429 || e.status === "RESOURCE_EXHAUSTED") {
    // "Resource has been exhausted" is the host's own; "exhausted your capacity on this model" is the account's allowance
    out.kind = lower.includes("resource has been exhausted") && !lower.includes("capacity on this model") && !retry && reason !== "RATE_LIMIT_EXCEEDED" ? "busy" : "limit"
  }
  if (out.kind === "validation") out.message = `Google wants this account verified before Antigravity serves it${paren(out.url)}: ${message}`
  if (out.kind === "violation") out.message = `Google has suspended this account's use of Antigravity: ${message}`
  return out
}
const paren = (u) => (u ? ` (${u})` : "")

/** An error answer from Code Assist, with what describe() read of it. */
export class CodeAssistError extends Error {
  constructor(status, text, method = "") {
    const d = describe(status, text)
    super(method ? `Antigravity ${method}: ${d.message} (${status})` : `Antigravity: ${d.message} (${status})`)
    this.status = status
    this.detail = d
    this.body = String(text ?? "")
  }
}

/**
 * An error saying the account's sign-in is gone — Google turned the refresh token down, or none is kept. `signIn:
 * "expired"` has magpie mark the account, so a request is not sent again and again with a token that can't be renewed.
 */
export const gone = (msg) => Object.assign(new Error(msg), { gone: true, signIn: "expired" })

export const EXPIRED = "Antigravity's sign-in has expired; sign in again"
