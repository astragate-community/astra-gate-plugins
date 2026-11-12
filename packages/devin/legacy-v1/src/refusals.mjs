// Devin's refusals: a Connect error (or a bare HTTP status) as the status and message a client is answered with.
import { statusText } from "@astragate-community/plugin-kit"

// failure is the status and message for a Connect error: {"code",
// "message"}, or at a stream's end {"error": {"code", "message"}}.
export function failure(status, text) {
  let msg = String(text ?? "").trim()
  let code = ""
  try {
    const e = JSON.parse(text)
    if (e?.error && typeof e.error === "object") [code, msg] = [e.error.code ?? "", e.error.message ?? ""]
    else if (e?.code) [code, msg] = [e.code, e.message ?? ""]
    msg ||= code
  } catch {}
  msg ||= statusText(status)
  const low = msg.toLowerCase()
  if (code === "unauthenticated") return { status: 401, message: msg + " — sign in to Devin again" }
  if (code === "resource_exhausted" || low.includes("quota") || low.includes("rate limit")) return { status: 429, message: "usage limit reached: " + msg }
  // Devin turns away some system prompts outright; sent again, the same
  // one is turned away again
  if (low.includes("content policy")) return { status: 400, message: msg }
  if (low.includes("too long") || low.includes("context length") || low.includes("too many tokens"))
    return { status: 400, message: "input is too long for the model's context: " + msg }
  if (code === "invalid_argument") return { status: 400, message: msg }
  if (code === "unavailable") return { status: 503, message: msg }
  if (code) return { status: 502, message: msg }
  return { status, message: msg }
}
