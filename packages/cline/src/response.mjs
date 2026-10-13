// Turning Cline's reply back: its refusals as OpenAI's errors, the sign-in mark on an answer, the non-streaming envelope.
import { STATUS_CODES } from "node:http"
import { errorResponse, kept } from "@astragate-community/plugin-kit"
import { firstOf, safeJson } from "./util.mjs"

// the refusals Cline's own client keys on, as it spells them (errors.ts and
// ClineError.ts): whole phrases and codes, never a loose substring — a 403
// that happens to mention "tokens" is not a lapsed sign-in
const NOT_SUBSCRIBED = "the user is not subscribed to required model plan"
const NOT_SUBSCRIBED_FORMATTED = "no access to clinepass subscription models yet. subscribe to clinepass"

// failure is an upstream chat refusal as OpenAI's API gives it. A refused
// chat is the sign-in at work, not the sign-in gone: only a refused refresh
// marks the account (errorResponse keeps it). The gates Cline puts in front
// of a model each say what they want: a plan subscription, or money.
export function failure(status, text) {
  if (status < 400 || status > 599) status = 502
  let msg = String(text ?? "").trim()
  let j = null
  try {
    j = JSON.parse(text)
  } catch {}
  const code = firstOf(j?.error?.code, j?.code, j?.error?.error)
  if (j) {
    if (typeof j?.error?.message === "string") msg = j.error.message
    else if (typeof j?.message === "string") msg = j.message
  }
  // Node's words for a status, kept here: the kit's statusText words it as Go does (magpie's refusals)
  msg ||= STATUS_CODES[status] ?? `HTTP ${status}`
  const low = msg.toLowerCase()
  // a model the account isn't entitled to: the sign-in is fine, the plan
  // isn't there (the cline-pass group, mostly)
  if (code === "ENTITLEMENT_ERROR" || low.includes(NOT_SUBSCRIBED) || low.includes(NOT_SUBSCRIBED_FORMATTED))
    return {
      status: 403,
      message: "this model needs a subscription the account hasn't got (ClinePass) — pick a usage-billed model, or subscribe at app.cline.bot (" + msg.replace(/^Error\s*\d*[:：]?\s*/, "") + ")",
    }
  // an empty account: say what the gateway said and where to fill it. The
  // code is the one Cline's client keys on; "Insufficient balance" is the
  // gateway's older wording for the same answer
  if (status === 402 || code === "insufficient_credits" || low.includes("insufficient_credits") || (low.includes("insufficient balance") && low.includes("cline credits balance"))) {
    const bal = Number(j?.error?.current_balance ?? j?.current_balance)
    const at = firstOf(j?.error?.buy_credits_url, j?.buy_credits_url) || "https://app.cline.bot/credits"
    return { status: 429, message: `out of credits ($${Number.isFinite(bal) ? bal.toFixed(2) : "0.00"}) — top up at ${at}` }
  }
  // the account's token was refused: 401 always, and a 403 only when it
  // says so in so many words — not when it merely mentions "token"
  if (status === 401 || (status === 403 && /^(unauthorized|invalid[ _]token|sign[ -]?in|not signed in|token (?:expired|invalid|revoked)|(?:access |refresh )?token expired)$/i.test(msg.trim())))
    return { status: 401, message: "the sign-in lapsed — sign in again" }
  // a spend cap or a rate limit, as Cline's client names them
  if (status === 429 || code === "SPEND_LIMIT_EXCEEDED" || /\b(?:rate limit|too many requests|quota exceeded|spend limit)\b/i.test(msg)) return { status: 429, message: "usage limit reached: " + msg }
  return { status, message: msg.slice(0, 2000) }
}

/** An error in OpenAI's shape, typed "cline_error"; it carries a sign-in mark only when `signIn` gives one. */
export const refusal = ({ status, message, signIn }) => errorResponse({ status, message, type: "cline_error", signIn: signIn ?? null })

/** What a failed token step answers a request: the sign-in gone is a 401 marked expired, anything else a 502. */
export const signedInError = (e) =>
  refusal({
    status: e?.expired ? 401 : 502,
    message: String(e?.message ?? e).replace(/^Cline: /, ""),
    signIn: e?.expired ? "expired" : undefined,
  })

// signed is res saying what it means for the sign-in: a renewed token cleared
// the lapse mark whatever came of the request
export function signed(res, renewed) {
  const said = renewed ? "renewed" : res.ok ? "kept" : null
  if (!said) return res
  const out = kept(res)
  out.headers.set("X-Magpie-Sign-In", said)
  return out
}

// unwrapped is Cline's non-streaming answer with its envelope taken off: a
// finished chat completion rides as {"data": …}, the shape the official
// clients take apart. Streaming answers are plain SSE and pass untouched.
export async function unwrapped(res) {
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res
  const text = await res.text()
  const j = safeJson(text)
  if (j && typeof j === "object" && Array.isArray(j.data?.choices))
    return new Response(JSON.stringify(j.data), { status: res.status, statusText: res.statusText, headers: { "Content-Type": "application/json" } })
  return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
}
