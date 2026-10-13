// Cursor's refusals: what a Connect error says, and the status and words it is given.
import { errorResponse, statusText } from "@astragate-community/plugin-kit"

export class AuthError extends Error {
  constructor(msg) {
    super(msg)
    this.status = 401
  }
}

// httpError is an Error that carries the status it is answered with.
export const httpError = (message, status) => Object.assign(new Error(message), { status })

// badGateway is the failure of an answer Cursor never gave (502): the status and words an error event carries.
export const badGateway = (message) => ({ status: 502, message })

// cursorError is a refusal in OpenAI's error shape. Every answer says X-Magpie-Sign-In: kept (the kit's default).
export const cursorError = ({ status, message }) => errorResponse({ status, message, type: "cursor_error" })

export const regional = (msg) => msg.toLowerCase().includes("region")

// failure is the status and message for Cursor's Connect error, whose
// details say it best: {"code", "message", "details": [{"debug": {"error",
// "details": {"title", "detail"}}}]}, or the same under "error" at a
// stream's end.
export function failure(status, text) {
  let e
  try {
    e = JSON.parse(typeof text === "string" ? text : Buffer.from(text).toString("utf8"))
  } catch {
    return statusOf(status, "", String(text ?? "").trim())
  }
  const f = e?.error && typeof e.error === "object" ? e.error : e ?? {}
  let msg = f.message ?? ""
  for (const d of f.details ?? []) {
    const t = `${d?.debug?.details?.title ?? ""}: ${d?.debug?.details?.detail ?? ""}`.trim()
    if (t !== ":") msg = t.replace(/^[:\s]+|[:\s]+$/g, "")
  }
  if (!msg || msg === "Error") msg = f.code ?? ""
  if (!f.code && status >= 200 && status < 300) return { status, message: msg } // a stream that ended well
  return statusOf(status, f.code ?? "", msg)
}

// statusOf is the status and words for Cursor's error of this code and
// message. A region the team isn't served in says so, not to sign in.
function statusOf(status, code, msg) {
  msg ||= statusText(status)
  const low = msg.toLowerCase()
  // magpie names the provider before the message itself
  const out = (status, message) => ({ status, message })
  if (regional(msg)) return out(403, msg + " — Cursor serves your team only in some regions and turned this request away; signing in again won't change that")
  if (code === "permission_denied") return out(403, msg)
  if (code === "unauthenticated" || status === 401 || low.includes("expired"))
    return out(401, msg + " — sign in to Cursor again in magpie")
  if (code === "resource_exhausted" || low.includes("quota") || low.includes("rate limit") || low.includes("usage limit"))
    return out(429, "usage limit reached: " + msg)
  if (low.includes("too long") || low.includes("context length") || low.includes("too many tokens"))
    return out(400, "input is too long for the model's context: " + msg)
  if (code === "invalid_argument") return out(400, msg)
  if (code === "unavailable") return out(503, msg)
  if (code) return out(502, msg)
  return out(status, msg)
}

// maxRequired is Cursor's refusal of a model asked for without Max Mode
// (the CLI's MAX_MODE_REQUIRED): "Max Mode Required: The model "x"
// requires Max Mode to be enabled. …"
export const maxRequired = (msg) => /max[ _]mode[ _]required|requires max mode/i.test(String(msg ?? ""))
