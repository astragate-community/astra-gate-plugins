// Kiro: the words for a refusal, and the errors the plugin throws.

// STATUS_TEXT is Go's http.StatusText for the answers Kiro gives.
const STATUS_TEXT = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 408: "Request Timeout",
  409: "Conflict", 413: "Request Entity Too Large", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout" }

export const statusWords = (status) => STATUS_TEXT[status] ?? ""
/** "<status> <words>", as Go's res.Status (no trailing space when Kiro's answer has no words here). */
export const statusLine = (status) => `${status} ${statusWords(status)}`.trimEnd()

/** JSON.parse that gives null for text that isn't JSON. */
export function tryJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// EXPIRED is the built-in's words for a sign-in Kiro refused, or one with
// nothing to refresh it.
export const EXPIRED = "Kiro's sign-in has expired; sign in again"
export const EXPIRED_CLI = EXPIRED + " with `kiro-cli login` or the Kiro IDE"

// gone is an error saying the sign-in itself is gone — refused, or never
// there. The built-in marked no Kiro account lapsed, not even then, nor
// cleared one: every answer and usage read says the account is kept.
export const gone = (msg) => Object.assign(new Error(msg), { gone: true })

/** An error answer from Kiro's management API. */
export class KiroError extends Error {
  constructor(status, body) {
    const msg = tryJSON(body)?.message ?? ""
    super(msg ? `Kiro: ${msg} (${status})` : `Kiro: ${statusWords(status)}`)
    this.status = status
    this.body = String(body ?? "")
  }
}
