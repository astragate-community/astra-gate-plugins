// WorkBuddy: its refusals, explained with what the user can do about them.

import { kept } from "@astragate-community/plugin-kit"
// REFUSED_HINT is what the user can do about WorkBuddy's "Illegal API
// invocation from an unapproved channel": both builds answer it to a chat
// holding words of Codex's or Claude Code's own (magpie #182), whatever the
// headers. FLAGGED rewrites the ones known; this is for one it doesn't know. It ends the error's message, as magpie's built-in
// put it (provider.WBRefusedHint), so magpie's routing page says it apart.
const REFUSED_HINT =
  "WorkBuddy refuses chats from Codex and Claude Code (their system prompt); use it from Hermes, OpenCode or Pi, or add another provider to this group"
const REFUSED = /unapproved channel|illegal api invocation/i

// RESTRICTED_HINT is what the user can do about WorkBuddy's 403 code 11140
// "request illegal", whose displayMsg says "Your account has been restricted
// due to unusual activity" (magpie #1849): the account is out until WorkBuddy
// lifts the restriction, which an appeal asks for. It ends the error's
// message as magpie's built-in puts it (provider.WBRestrictedHint), word for
// word, so magpie rests the account for hours rather than minutes.
const RESTRICTED_HINT =
  "WorkBuddy restricted this account for unusual activity; it stays out until WorkBuddy lifts that, which an appeal (Submit feedback in WorkBuddy) asks for"
const RESTRICTED_CODE = 11140
// The code is matched whole, as with 14018: 111400 is another error.
const RESTRICTED_TEXT = /account has been restricted due to unusual activity|账号存在异常行为|帳號存在異常行為|["']code["']\s*:\s*["']?11140(?![\d.])/i

// EXHAUSTED_HINT explains WorkBuddy's requirement of an active package
// even for 0-rate / free models. When an account has no packages or 0 credits,
// WorkBuddy returns code 14018 ("Credits exhausted...").
const EXHAUSTED_HINT =
  "WorkBuddy requires an active credit package even for 0-rate free models; check your account package balance"
// The code is matched whole: a code that only begins with 14018 (140185) is
// another error, and insufficient_quota would rest the account as out of credit.
const EXHAUSTED_TEXT = /credits exhausted|额度已用尽|["']code["']\s*:\s*["']?14018(?![\d.])/i

// explained is res with REFUSED_HINT, RESTRICTED_HINT or EXHAUSTED_HINT added to that refusal's message.
// Each refusal says the sign-in is kept: the built-in passed WorkBuddy's
// 401 on and never marked a WorkBuddy account lapsed.
export async function explained(res) {
  const text = await res.text()
  let v
  try {
    v = JSON.parse(text)
  } catch {}
  const at = v?.error && typeof v.error === "object" ? v.error : v && typeof v === "object" ? v : null
  const code = at?.data?.code ?? at?.code ?? v?.code ?? v?.data?.code
  const isRefused = REFUSED.test(text)
  const isRestricted = !isRefused && (Number(code) === RESTRICTED_CODE || RESTRICTED_TEXT.test(text))
  const isExhausted = !isRestricted && (code === 14018 || Number(code) === 14018 || EXHAUSTED_TEXT.test(text))
  if (!isRefused && !isRestricted && !isExhausted) return kept(res, text)

  let msg = text.trim()
  if (at && typeof at.message === "string") msg = at.message
  else if (typeof at?.data?.msg === "string") msg = at.data.msg
  else if (typeof v?.error === "string") msg = v.error
  else if (typeof v?.msg === "string" && v.msg) msg = v.msg // WorkBuddy's own {"code", "msg"}
  else if (typeof v?.data?.msg === "string") msg = v.data.msg

  const hint = isRefused ? REFUSED_HINT : isRestricted ? RESTRICTED_HINT : EXHAUSTED_HINT
  const type = isRefused || isRestricted ? "permission_error" : "insufficient_quota"
  const errCode = isRefused ? null : isRestricted ? RESTRICTED_CODE : 14018
  msg = `${msg} — ${hint}`
  const out = kept(res, JSON.stringify({ error: { message: msg, type, code: errCode } }))
  out.headers.set("content-type", "application/json")
  return out
}
