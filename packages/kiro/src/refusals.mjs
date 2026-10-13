// Kiro: a refusal — Kiro's error answers, and the plugin's own errors in Messages' shape.
import { KEPT } from "@astragate-community/plugin-kit"
import { statusWords, tryJSON } from "./errors.mjs"

// failure is the status and message for an error Kiro answered with:
// {"message": "...", "reason": "..."}.
export function failure(status, body) {
  let msg = String(body ?? "").trim()
  const e = tryJSON(body)
  if (e?.message) msg = e.message + (e.reason ? ` (${e.reason})` : "")
  msg ||= statusWords(status)
  if (msg.includes("CONTENT_LENGTH_EXCEEDS_THRESHOLD") || msg.toLowerCase().includes("input is too long"))
    return { status: 400, message: "input is too long for the model's context: " + msg }
  if (msg.includes("INSUFFICIENT_MODEL_CAPACITY")) return { status: 503, message: msg }
  if (msg.includes("MONTHLY_REQUEST_COUNT") || msg.includes("USAGE_LIMIT")) return { status: 429, message: "usage limit reached: " + msg }
  return { status, message: msg }
}

const ERROR_TYPES = { 400: "invalid_request_error", 401: "authentication_error", 402: "billing_error", 403: "permission_error",
  404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 503: "overloaded_error", 529: "overloaded_error" }
const errorType = (status) => ERROR_TYPES[status] ?? "api_error"

// messagesError is a refusal in Anthropic's error shape (the kit's errorResponse is OpenAI's). Each failure says
// X-Magpie-Sign-In: kept, as the built-in never marked an account lapsed (see gone).
export const messagesError = (status, message) =>
  new Response(JSON.stringify({ type: "error", error: { type: errorType(status), message } }), {
    status,
    headers: { "Content-Type": "application/json", ...KEPT },
  })

// quotaWords are magpie's (internal/gateway/fallback.go): how a vendor says
// "out of quota" or "slow down".
const QUOTA_WORDS = /quota|insufficient|balance|credit|billing|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i

// failedBefore is the reply to an error before any of the answer, as
// magpie's built-in relay gives it: a status, not a stream, so another
// account can take over — a 429 when it reads as a quota or rate limit,
// else a 502.
export const failedBefore = (text) => messagesError(QUOTA_WORDS.test(text) ? 429 : 502, text)
