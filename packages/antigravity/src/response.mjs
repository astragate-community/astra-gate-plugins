// Antigravity: what Code Assist answers, as Gemini says it — each chunk of the stream unwrapped, a reply whole, a refusal.
import { KEPT } from "@astragate-community/plugin-kit"
import { describe, tryJSON } from "./errors.mjs"

/** The data of each complete event in `buffer`, and what is left after them (the start of the next). */
export function splitEvents(buffer) {
  const events = []
  let rest = buffer
  for (;;) {
    const m = /\r?\n\r?\n/.exec(rest)
    if (!m) break
    const block = rest.slice(0, m.index)
    rest = rest.slice(m.index + m[0].length)
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n")
    if (data) events.push(data)
  }
  return { events, rest }
}

/** One chunk of Code Assist's stream as Gemini's own: {"response": …} unwrapped, an error kept as {"error": …}. null for what isn't JSON. */
export function unwrap(data) {
  const o = tryJSON(data)
  if (!o || typeof o !== "object") return null
  if (o.response && typeof o.response === "object") return o.response
  return o
}

/** A Response whose body is Code Assist's stream as Gemini's: the same events, each unwrapped. */
export function streamOf(res) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let rest = ""
  const emit = (controller, events) => {
    for (const data of events) {
      const chunk = unwrap(data)
      if (chunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\r\n\r\n`))
    }
  }
  const body = res.body.pipeThrough(
    new TransformStream({
      transform(bytes, controller) {
        const got = splitEvents(rest + decoder.decode(bytes, { stream: true }))
        rest = got.rest
        emit(controller, got.events)
      },
      flush(controller) {
        emit(controller, splitEvents(rest + decoder.decode() + "\n\n").events)
      },
    }),
  )
  return new Response(body, { status: res.status, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...KEPT } })
}

// a part of text goes on the text before it when both are of one kind (an answer's, or a thought's)
function append(parts, p) {
  const last = parts[parts.length - 1]
  if (last && typeof p.text === "string" && typeof last.text === "string" && !last.functionCall && !!p.thought === !!last.thought) {
    last.text += p.text
    if (p.thoughtSignature) last.thoughtSignature = p.thoughtSignature
  } else parts.push({ ...p })
}

/** The chunks of a stream as one reply, as Gemini answers a request that isn't streamed. */
export function merge(chunks) {
  const out = {}
  const cand = { content: { role: "model", parts: [] }, index: 0 }
  for (const c of chunks) {
    for (const k of ["responseId", "modelVersion"]) if (c[k]) out[k] = c[k]
    if (c.usageMetadata) out.usageMetadata = c.usageMetadata
    if (c.promptFeedback) out.promptFeedback = c.promptFeedback
    for (const cd of Array.isArray(c.candidates) ? c.candidates : []) {
      for (const p of Array.isArray(cd?.content?.parts) ? cd.content.parts : []) append(cand.content.parts, p)
      for (const k of ["finishReason", "groundingMetadata", "safetyRatings"]) if (cd?.[k]) cand[k] = cd[k]
    }
  }
  return { candidates: [cand], ...out }
}

/** A Response with the whole reply, read from the stream; a stream that says it failed is the failure. */
export async function collect(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let rest = ""
  const chunks = []
  const read = (events) => {
    for (const data of events) {
      const chunk = unwrap(data)
      if (chunk) chunks.push(chunk)
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const got = splitEvents(rest + decoder.decode(value, { stream: true }))
    rest = got.rest
    read(got.events)
  }
  read(splitEvents(rest + decoder.decode() + "\n\n").events)
  const failed = chunks.find((c) => c.error)
  if (failed) return refusal(failed.error.code ?? 502, String(failed.error.message ?? "Antigravity's stream failed"))
  return new Response(JSON.stringify(merge(chunks)), { status: 200, headers: { "content-type": "application/json", ...KEPT } })
}

const RPC = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 409: "ABORTED", 413: "INVALID_ARGUMENT",
  429: "RESOURCE_EXHAUSTED", 500: "INTERNAL", 502: "UNAVAILABLE", 503: "UNAVAILABLE", 504: "DEADLINE_EXCEEDED" }

/** A refusal in Gemini's error shape; `waitMs` (when known) is said as Retry-After, which is what lets a caller route around a limit. */
export function refusal(status, message, { waitMs = 0, signIn = "kept" } = {}) {
  const headers = { "content-type": "application/json", ...(signIn ? { "x-magpie-sign-in": signIn } : {}) }
  if (waitMs > 0) headers["retry-after"] = String(Math.ceil(waitMs / 1000))
  return new Response(JSON.stringify({ error: { code: status, message, status: RPC[status] ?? "UNKNOWN" } }), { status, headers })
}

/** Code Assist's refusal of a request, answered as Gemini would. */
export function failed(status, text) {
  const d = describe(status, text)
  const hint = d.kind === "busy" ? " (the host that answered is busy; asking another did not help)" : ""
  return refusal(status, d.message + hint, { waitMs: d.waitMs })
}
