// Trae: what it says went wrong, and the refusals the agent is given for it.
import { STATUS_CODES } from "node:http"
import { parseJSON } from "./values.mjs"

// A sign-in Trae turned away: the account is marked for a new sign-in (magpie's X-Magpie-Sign-In: expired).
export class Expired extends Error {
  constructor(msg) {
    super(msg)
    this.signIn = "expired"
  }
}

// "<n> <words>" as the messages here carry a status. Kept local: the kit's statusText gives the words alone
// (Go's, "HTTP <n>" when it has none).
export const statusLine = (status) => `${status} ${STATUS_CODES[status] ?? ""}`.trim()

// errorOf is what Trae said went wrong, from its several shapes: a business
// {code, message}, {error: {code, message}}, or ByteDance's
// {ResponseMetadata: {Error: {Code, Message}}}
export function errorOf(v) {
  v = parseJSON(v)
  const meta = v?.ResponseMetadata?.Error
  if (meta && (meta.Code || meta.Message)) return { code: meta.Code ?? "", message: String(meta.Message ?? meta.Code ?? "") }
  const e = v?.error && typeof v.error === "object" ? v.error : v
  const code = e?.code ?? e?.Code ?? v?.code ?? ""
  const message = e?.message ?? e?.msg ?? e?.Message ?? (typeof v?.error === "string" ? v.error : "") ?? ""
  return { code, message: String(message || "") }
}

// lapsed: Trae turned the token away. 1001 is its "not signed in".
// The realms differ in which codes they send: the international deployment
// also answers 20101 for a token it no longer takes.
const CN_LAPSED = [1001, "1001", 401, "401"]
export const lapsedCode = (code, site) => (site?.lapsed ?? CN_LAPSED).includes(code)
const lapsedWords = /not ?log(ged)? ?in|unauthori[sz]ed|token (is )?(expired|invalid)|jwt|未登录|登录(已)?(过期|失效)/i
const CN_QUOTA = [4008, "4008", 1005, "1005"]
const quotaCode = (code, site) => (site?.quota ?? CN_QUOTA).includes(code)
const quotaWords = /quota|credit|insufficient|exceed|limit|额度|积分|次数|上限|用完/i

// errorResponse is an OpenAI-style error, as the agent reads one. Kept local: the kit's has another body
// (type "upstream_error", the status as code) and marks every answer's sign-in.
export const errorResponse = (status, message, signIn) => {
  const headers = { "content-type": "application/json" }
  if (signIn) headers["X-Magpie-Sign-In"] = signIn
  return new Response(JSON.stringify({ error: { message, type: status === 429 ? "rate_limit_error" : "api_error", code: null } }), { status, headers })
}

// the refusal for an account whose sign-in is gone, as the agent gets it
export const expiredResponse = (a, e) => errorResponse(401, `${a.name || a.uid}: ${e.message}`, "expired")

// failure is the response for an error Trae answered with
export function failure(site, status, code, message) {
  message = message || statusLine(status)
  if (status === 401 || lapsedCode(code, site) || (status === 403 && lapsedWords.test(message))) {
    return errorResponse(401, `${site.realm}'s sign-in has expired (${message}); sign in again`, "expired")
  }
  if (status === 429 || quotaCode(code, site) || (status === 403 && quotaWords.test(message))) return errorResponse(429, `${site.realm}: ${message}`)
  return errorResponse(status >= 400 ? status : 502, `${site.realm}: ${message}${code ? ` (code ${code})` : ""}`)
}

// a model or function this account's chat_v3 doesn't take: another may
export const wrongFunction = (code) => ["4001", "4023", "1005"].includes(String(code))
