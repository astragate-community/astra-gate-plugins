// Antigravity: what Code Assist answers, as Gemini says it. The host frames the stream (reply.framing "sse") and calls
// transformResponse per event: each {"response": …} envelope is unwrapped; a request that isn't streamed gets the chunks
// merged into one reply; a refusal keeps Google's own words (validation, suspension, busy host).
import { describe, tryJSON } from "./errors.js"

// the chunk of Code Assist's stream as Gemini's own: {"response": …} unwrapped, an error kept as {"error": …}; null for what isn't JSON
export function unwrap(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null
  if (o.response && typeof o.response === "object") return o.response
  return o
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

// a refusal's status and words: Google's own (describe), the busy hint as before
export function refusalOf(status, text) {
  const d = describe(status, text)
  const hint = d.kind === "busy" ? " (the host that answered is busy; another host may not be)" : ""
  return { status, message: d.message + hint }
}

export const transformResponse = {
  // 401 passes through (the refresh runs); any other refusal is Google's words under its status
  start(res) {
    if (res.status < 400 || res.status === 401) return
    return { error: refusalOf(res.status, String(res.body ?? "")) }
  },

  frame(f, ctx) {
    const chunk = unwrap(f.json ?? (typeof f.data === "string" ? tryJSON(f.data) : null))
    if (!chunk) return
    if (chunk.error) {
      const code = Number(chunk.error.code)
      const status = code >= 400 && code <= 599 ? code : 502
      return { $error: refusalOf(status, JSON.stringify({ error: { ...chunk.error, message: String(chunk.error.message ?? "Antigravity's stream failed") } })) }
    }
    if (ctx.request.stream) return chunk
    ;(ctx.state.chunks ??= []).push(chunk)
  },

  end(ctx) {
    if (ctx.request.stream) return
    return merge(ctx.state.chunks ?? [])
  },
}
