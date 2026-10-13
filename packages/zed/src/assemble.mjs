// Whole replies: a provider's stream events folded into the one reply it gives a caller that didn't ask for a stream.
import { parse } from "./json.mjs"
import { RESPONSES_DONE } from "./wire.mjs"

function anthropicWhole(events) {
  let msg = null
  const blocks = []
  const json = {}
  for (const ev of events) {
    switch (ev?.type) {
      case "message_start":
        msg = { ...ev.message, content: [] }
        break
      case "content_block_start":
        blocks[ev.index] = { ...ev.content_block }
        if (ev.content_block?.type === "tool_use") json[ev.index] = ""
        break
      case "content_block_delta": {
        const b = blocks[ev.index]
        const d = ev.delta ?? {}
        if (!b) break
        if (d.type === "text_delta") b.text = (b.text ?? "") + d.text
        else if (d.type === "input_json_delta") json[ev.index] = (json[ev.index] ?? "") + d.partial_json
        else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking
        else if (d.type === "signature_delta") b.signature = (b.signature ?? "") + d.signature
        break
      }
      case "message_delta":
        if (msg) {
          Object.assign(msg, ev.delta ?? {})
          msg.usage = { ...(msg.usage ?? {}), ...(ev.usage ?? {}) }
        }
        break
    }
  }
  for (const [i, s] of Object.entries(json)) if (blocks[i]) blocks[i].input = s ? parse(s) ?? {} : {}
  msg ??= { type: "message", role: "assistant", content: [] }
  msg.content = blocks.filter(Boolean)
  return msg
}

function responsesWhole(events) {
  for (const ev of events.slice().reverse()) {
    if (RESPONSES_DONE.includes(ev?.type) && ev.response) return ev.response
  }
  return null
}

function chatWhole(events) {
  let out = null
  const choices = []
  for (const ev of events) {
    out ??= { id: ev.id, object: "chat.completion", created: ev.created, model: ev.model }
    if (ev.usage) out.usage = ev.usage
    for (const c of ev.choices ?? []) {
      const ch = (choices[c.index ?? 0] ??= { index: c.index ?? 0, message: { role: "assistant", content: "" }, finish_reason: null })
      const d = c.delta ?? {}
      if (d.content) ch.message.content += d.content
      if (d.reasoning_content) ch.message.reasoning_content = (ch.message.reasoning_content ?? "") + d.reasoning_content
      for (const t of d.tool_calls ?? []) {
        const calls = (ch.message.tool_calls ??= [])
        const tc = (calls[t.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } })
        if (t.id) tc.id = t.id
        if (t.function?.name) tc.function.name += t.function.name
        if (t.function?.arguments) tc.function.arguments += t.function.arguments
      }
      if (c.finish_reason) ch.finish_reason = c.finish_reason
    }
  }
  out ??= { object: "chat.completion" }
  out.choices = choices.filter(Boolean)
  return out
}

function geminiWhole(events) {
  const out = { candidates: [] }
  for (const ev of events) {
    if (ev.usageMetadata) out.usageMetadata = ev.usageMetadata
    if (ev.modelVersion) out.modelVersion = ev.modelVersion
    for (const [i, c] of (ev.candidates ?? []).entries()) {
      const k = c.index ?? i
      const cand = (out.candidates[k] ??= { content: { role: "model", parts: [] }, index: k })
      for (const p of c.content?.parts ?? []) {
        const last = cand.content.parts.at(-1)
        if (typeof p.text === "string" && last && typeof last.text === "string" && !!last.thought === !!p.thought && Object.keys(p).every((x) => x === "text" || x === "thought")) last.text += p.text
        else cand.content.parts.push({ ...p })
      }
      if (c.finishReason) cand.finishReason = c.finishReason
    }
  }
  return out
}

const WHOLE = { anthropic: anthropicWhole, responses: responsesWhole, chat: chatWhole, gemini: geminiWhole }

/** The events of a reply as the one object the provider's API answers with (null when there is none to give). */
export const assemble = (wire, events) => WHOLE[wire](events)
