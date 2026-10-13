// Zed's completion stream and the providers' own wire formats: reading Zed's lines, telling what an event
// says, and writing events and failures the way the caller's API does.
import { parse } from "./json.mjs"

// lines reads a completion's stream line by line. wrapped is whether the
// reply said it sends statuses; without, each line is a bare event.
export async function* lines(body, wrapped) {
  const dec = new TextDecoder()
  let buf = ""
  const one = function* (raw) {
    const s = raw.trim()
    if (!s) return
    const j = parse(s)
    if (j === undefined) throw new Error("Zed: an unreadable line")
    if (!wrapped) return yield { event: j }
    if (j.event !== undefined) return yield { event: j.event }
    if (j.status === "stream_ended") return yield { ended: true }
    if (j.status?.failed) return yield { failed: j.status.failed }
    // "started", {"queued": …} and newer statuses say nothing to act on
  }
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i)
      buf = buf.slice(i + 1)
      yield* one(l)
    }
  }
  buf += dec.decode()
  yield* one(buf)
}

// sse writes one event the way its provider's API streams it.
export function sse(wire, ev) {
  const data = "data: " + JSON.stringify(ev) + "\n\n"
  if ((wire === "anthropic" || wire === "responses") && ev?.type) return `event: ${ev.type}\n` + data
  return data
}

const STATUS_NAME = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 402: "RESOURCE_EXHAUSTED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 429: "RESOURCE_EXHAUSTED", 529: "UNAVAILABLE" }
const ANTHROPIC_ERROR = { 400: "invalid_request_error", 401: "authentication_error", 402: "billing_error", 403: "permission_error", 404: "not_found_error", 429: "rate_limit_error", 529: "overloaded_error" }

// errorBody is a failure in the caller's API's own shape.
export function errorBody(wire, status, message) {
  switch (wire) {
    case "anthropic":
      return { type: "error", error: { type: ANTHROPIC_ERROR[status] ?? "api_error", message } }
    case "responses":
      return { type: "error", code: String(status), message, error: { message, code: String(status) } }
    case "gemini":
      return { error: { code: status, message, status: STATUS_NAME[status] ?? "INTERNAL" } }
    default:
      return { error: { message, type: "api_error", code: status } }
  }
}

// errorEvent is a failure written into a stream already begun.
export function errorEvent(wire, status, message) {
  const data = `data: ${JSON.stringify(errorBody(wire, status, message))}\n\n`
  return wire === "anthropic" || wire === "responses" ? "event: error\n" + data : data
}

// errorResponse is a failure as the caller's API gives it. signIn is what it
// means for the account (magpie's X-Magpie-Sign-In): the built-in marked
// the account lapsed only when Zed refused its sign-in, so any other 401
// (a model token refused twice, a vendor's upstream_http_401) is kept.
export const errorResponse = (wire, status, message, signIn = status === 401 ? "kept" : undefined) =>
  new Response(JSON.stringify(errorBody(wire, status, message)), {
    status,
    headers: { "content-type": "application/json", ...(signIn ? { "x-magpie-sign-in": signIn } : {}) },
  })

// said tells whether one of the provider's own events says anything —
// text, reasoning, a call, a finish — rather than only framing the reply,
// as magpie's decoders tell a reply begun from its lead (message_start,
// response.created, a role-only chunk).
export function said(wire, ev) {
  if (!ev || typeof ev !== "object") return true
  switch (wire) {
    case "anthropic":
      switch (ev.type) {
        case "message_start":
        case "ping":
        case "content_block_stop":
          return false
        case "content_block_start":
          return !["text", "thinking", "redacted_thinking"].includes(ev.content_block?.type) || !!(ev.content_block?.text || ev.content_block?.thinking)
        case "content_block_delta": {
          const d = ev.delta ?? {}
          return !(d.text === "" || d.thinking === "" || d.partial_json === "")
        }
      }
      return true
    case "responses":
      switch (ev.type) {
        case "response.created":
        case "response.in_progress":
        case "response.queued":
        case "response.content_part.added":
        case "response.reasoning_summary_part.added":
          return false
        case "response.output_item.added":
          return !["message", "reasoning"].includes(ev.item?.type)
        case "response.output_text.delta":
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          return ev.delta !== ""
      }
      return true
    case "chat":
      if (ev.error) return true
      if (!Array.isArray(ev.choices)) return false // usage alone
      return ev.choices.some((c) => {
        const d = c?.delta ?? {}
        return !!(c?.finish_reason || d.content || d.reasoning_content || d.reasoning || d.tool_calls?.length)
      })
    case "gemini":
      if (ev.error) return true
      return (ev.candidates ?? []).some((c) => c?.finishReason || (c?.content?.parts ?? []).some((p) => p?.text || p?.functionCall || p?.thought))
  }
  return true
}

// the Responses events that end a reply
export const RESPONSES_DONE = ["response.completed", "response.incomplete", "response.failed"]

// eventError is the message of an error the provider's own stream carries
// (Anthropic's error event, a failed response, a chat or Gemini chunk's
// error), undefined for any other event.
export function eventError(wire, ev) {
  if (!ev || typeof ev !== "object") return undefined
  if (wire === "anthropic" && ev.type === "error") return String(ev.error?.message ?? "")
  if (wire === "responses") {
    if (RESPONSES_DONE.includes(ev.type) && ev.response?.error) return String(ev.response.error.message ?? "")
    if (ev.type === "error") return String((ev.error ? ev.error.message : ev.message) ?? "")
    return undefined
  }
  if ((wire === "chat" || wire === "gemini") && ev.error) return String(ev.error?.message ?? "")
  return undefined
}
