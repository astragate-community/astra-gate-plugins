// Command Code's refusals and stream errors, turned into a status and message and answered in OpenAI's error shape
import { errorResponse, statusText } from "@astragate-community/plugin-kit"

// QUOTA_WORDS are magpie's quotaWords (internal/gateway/fallback.go): a
// message already in them isn't said again as out of credits.
const QUOTA_WORDS = /quota|insufficient|balance|credit|billing|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i

// failure is the status and message for a failure, from Command Code's
// {"error":{"type","message"}} or its text: a model the plan hasn't is a
// 403, credits run out a 402, a window's limit a 429.
export function failure(status, text) {
  let msg = ""
  try {
    const j = JSON.parse(text)
    const err = j?.error && typeof j.error === "object" ? JSON.stringify(j.error) : j?.error
    msg = [j?.error?.message, j?.message, err].find((s) => s != null && String(s).trim()) ?? ""
  } catch {}
  // an empty body is its status's name, as Go's http.StatusText says it:
  // an empty 429 reads "Too Many Requests", which quotaWords knows
  msg = String(msg || text || "").trim() || statusText(status)
  if (msg.length > 600) msg = msg.slice(0, 600)
  const low = msg.toLowerCase()
  if (msg.includes("MODEL_NOT_IN_PLAN:")) {
    status = 403
    msg = "Model not in plan: " + msg.replace("MODEL_NOT_IN_PLAN:", "").trim()
  } else if (low.includes("model_not_in_plan")) status = 403
  else if (low.includes("premium_credits_exhausted") || low.includes("insufficient credits")) {
    status = 402
    msg = msg.replace("PREMIUM_CREDITS_EXHAUSTED:", "").trim()
    if (!QUOTA_WORDS.test(msg)) msg = "out of credits: " + msg
  } else if (msg.includes("RATE_LIMITED") || low.includes("usage limit") || low.includes("window_limit")) {
    if (status < 400 || status === 500) status = 429
  }
  if (status < 400 || status > 599) status = 502
  return { status, message: msg }
}

// streamError is an error line's status and message: a string, or
// {message, statusCode}, whose message may hold the HTTP error it was.
export function streamError(e) {
  let msg = typeof e === "string" ? e : e?.message ?? ""
  let status = typeof e === "object" ? Number(e?.statusCode) || 0 : 0
  msg ||= "Stream error"
  const i = msg.indexOf("{")
  if (i >= 0) {
    try {
      const j = JSON.parse(msg.slice(i))
      const n = parseInt(msg.slice(0, i).trim(), 10)
      if (n >= 400) status = n
      if (j?.error?.message) msg = j.error.message
    } catch {}
  }
  return failure(status || 500, msg)
}

// refusal is a failure as the built-in answered it, the account kept: the
// built-in never marked a Command Code account lapsed, a 401 of Command
// Code's among them.
export const refusal = ({ status, message }) => errorResponse({ status, message, type: "commandcode_error" })
