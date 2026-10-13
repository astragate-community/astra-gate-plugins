// Xiaomi MiMo: how a refusal or a failed read is worded.
import { STATUS_CODES } from "node:http"
import { tryJSON } from "./json.mjs"

// SignInGone is an account Xiaomi no longer signs in: it must be signed in
// again.
export class SignInGone extends Error {}

// the words for an account whose sign-in is over, as the built-in's mimoLapse said them
export const expiredMessage = (who) => `${who}: the Xiaomi MiMo sign-in has expired — sign in again`

// statusLine is a status as Go's HTTP client names it, "502 Bad Gateway".
export const statusLine = (status) => `${status} ${STATUS_CODES[status] ?? ""}`.trim()

// vendorError is the message in an error body as magpie reads it: its
// {error: {message}} or {error}, {message}, {msg}, {detail}, else the body
// cut short after the status.
export function vendorError(text, fallback) {
  const v = tryJSON(text)
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
