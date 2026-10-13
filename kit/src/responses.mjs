import { statusText } from "./http.mjs"

/** Marks an answer that went through: the account's sign-in is still good (magpie's X-Magpie-Sign-In). */
export const KEPT = { "x-magpie-sign-in": "kept" }

/** res with the sign-in marked kept; body replaces its body when given (a body already read). */
export function kept(res, body) {
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("x-magpie-sign-in", "kept")
  return new Response(body !== undefined ? body : res.body, { status: res.status, statusText: res.statusText, headers })
}

/**
 * A refusal in OpenAI's error shape. A 401 keeps the sign-in unless `signIn` says otherwise ("expired" marks
 * the account lapsed); `type` names the vendor ("devin_error").
 */
export function errorResponse({ status, message, type = "upstream_error", signIn = "kept" }) {
  const text = message || statusText(status)
  return new Response(JSON.stringify({ error: { message: text, type, code: status } }), {
    status,
    headers: { "content-type": "application/json", ...(signIn ? { "x-magpie-sign-in": signIn } : {}) },
  })
}
