// Factory: refusals from WorkOS and Factory's API, and how they are worded.
import { STATUS_CODES } from "node:http"

export class FactoryStatus extends Error {
  constructor(code, message, body) {
    super(message)
    this.code = code
    this.body = body
  }
}

// refused is WorkOS turning the refresh token away for good: any 4xx but a
// rate limit, as droid reads it.
export const refused = (e) => e instanceof FactoryStatus && e.code >= 400 && e.code < 500 && e.code !== 429

// orgRefused is Factory's 403 for an X-Factory-Org-Id the user can't reach:
// "Requested active organization is not accessible by this user".
export const orgRefused = (status, text) => status === 403 && text.toLowerCase().includes("active organization is not accessible")

// explain is what the user can do about a 403 Factory still answers once
// the request carries what droid sends.
export function explain(status, text) {
  if (status !== 403) return ""
  if (orgRefused(status, text)) return "the Factory account's organization changed; remove the account in magpie and sign in to it again"
  return "Factory refused the request. magpie adapts fixed client metadata on both OpenAI and Anthropic routes. Factory may still refuse unsupported fields or wrappers; check the upstream error, the organization's model policy, plan and regional provider availability, and compare the same model in Droid"
}

// signInFailure is WorkOS answering a sign-in call with neither tokens nor an OAuth error. Node's words for the
// status, not the kit's statusText (Go's): these messages are Factory's, as the plugin has always worded them.
export const signInFailure = (status, text) => new FactoryStatus(status, "Factory sign-in: " + vendorError(text, STATUS_CODES[status] ?? ""))

// statusLine is a status as Go's HTTP client names it, "403 Forbidden".
export const statusLine = (status) => `${status} ${STATUS_CODES[status] ?? ""}`.trim()

// vendorError is the message in an error body as magpie reads it: Factory's
// {error: {message}} or {error}, {message}, {detail}, else the body cut
// short after the status.
export function vendorError(text, fallback) {
  let v
  try {
    v = JSON.parse(text)
  } catch {}
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const err = v.detail !== undefined && v.detail !== null ? v.detail : v.error
    if (Array.isArray(v.errors) && typeof v.errors[0]?.message === "string" && v.errors[0].message) return v.errors[0].message
    if (err && typeof err === "object" && typeof err.message === "string" && err.message) return err.message
    if (typeof err === "string" && err) return err
    const m = (typeof v.message === "string" && v.message) || (typeof v.msg === "string" && v.msg)
    if (m) return m
  }
  const s = String(text ?? "").split(/\s+/).filter(Boolean).join(" ")
  if (!s || s.startsWith("<")) return fallback
  const r = [...s]
  return fallback + ": " + (r.length > 300 ? r.slice(0, 300).join("") + "…" : s)
}

// lapsed is WorkOS refusing c's refresh token for good: the account
// needs signing in again
export const lapsed = (c, e) =>
  Object.assign(new Error(`${c.accountId || "the account"}'s Factory sign-in has expired — sign in again (${e.message})`), { lapsed: true, signIn: "expired" })
