// Kiro: the reply — Kiro's events as Messages: a stream of Messages' events, or one message.
import { randomBytes } from "node:crypto"
import { failedBefore, messagesError } from "./refusals.mjs"

// finished is the message's blocks with each call's arguments read.
function finished(content) {
  for (const b of content)
    if (b.type === "tool_use") {
      try {
        b.input = b.input ? JSON.parse(b.input) : {}
      } catch {
        b.input = {}
      }
    }
  return content
}

export const anthropicUsage = (u) => ({
  input_tokens: u.input,
  output_tokens: u.output,
  cache_read_input_tokens: u.cacheRead,
  cache_creation_input_tokens: u.cacheWrite,
})

const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

// message is a whole Messages answer.
const message = (id, model, content, reason, usage) =>
  Response.json({ id, type: "message", role: "assistant", model, content: finished(content), stop_reason: reason, stop_sequence: null,
    usage: anthropicUsage(usage) })

// the name the caller knows for a tool Kiro was sent under another (toolNames)
const nameOf = (names, e) => names.get(e.name) ?? e.name

// whole answers with one message: the events gathered into blocks.
async function whole(it, id, model, names) {
  const content = []
  let last = null
  const add = (block) => {
    content.push(block)
    last = block
  }
  for await (const e of it) {
    if (e.kind === "text") {
      if (last?.type === "text") last.text += e.text
      else add({ type: "text", text: e.text })
    } else if (e.kind === "think") {
      if (last?.type === "thinking") last.thinking += e.text
      else add({ type: "thinking", thinking: e.text, signature: "" })
    } else if (e.kind === "sig") {
      if (last?.type === "thinking") last.signature += e.text
    } else if (e.kind === "toolStart") add({ type: "tool_use", id: e.id, name: nameOf(names, e), input: "" })
    else if (e.kind === "toolArgs") {
      if (last?.type === "tool_use") last.input += e.text
    } else if (e.kind === "error") {
      // with none of the answer said, a status; else what was said
      if (!content.length) return failedBefore(e.text)
      return message(id, model, content, "end_turn", NO_USAGE)
    } else if (e.kind === "stop") return message(id, model, content, e.reason, e.usage)
  }
  return messagesError(502, "the reply ended before it was complete")
}

// streamed answers with Messages' event stream.
async function streamed(it, id, model, names) {
  // an error before any of the answer is a status, as the built-in's
  const head = await it.next()
  if (head.value?.kind === "error") return failedBefore(head.value.text)
  let pending = head

  const enc = new TextEncoder()
  const sse = (type, data) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  let index = -1
  let open = "" // the kind of block open
  let started = false
  const body = new ReadableStream({
    async pull(ctl) {
      if (!started) {
        started = true
        ctl.enqueue(sse("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null,
          stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }))
        return
      }
      const close = () => {
        if (open) ctl.enqueue(sse("content_block_stop", { index }))
        open = ""
      }
      const begin = (kind, block) => {
        close()
        index++
        open = kind
        ctl.enqueue(sse("content_block_start", { index, content_block: block }))
      }
      const r = pending ?? (await it.next())
      pending = null
      if (r.done) return ctl.close()
      const e = r.value
      switch (e.kind) {
        case "text":
          if (open !== "text") begin("text", { type: "text", text: "" })
          ctl.enqueue(sse("content_block_delta", { index, delta: { type: "text_delta", text: e.text } }))
          break
        case "think":
          if (open !== "thinking") begin("thinking", { type: "thinking", thinking: "", signature: "" })
          ctl.enqueue(sse("content_block_delta", { index, delta: { type: "thinking_delta", thinking: e.text } }))
          break
        case "sig":
          if (open === "thinking") ctl.enqueue(sse("content_block_delta", { index, delta: { type: "signature_delta", signature: e.text } }))
          break
        case "toolStart":
          begin("tool", { type: "tool_use", id: e.id, name: nameOf(names, e), input: {} })
          break
        case "toolArgs":
          if (open === "tool") ctl.enqueue(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: e.text } }))
          break
        case "error":
          close()
          ctl.enqueue(sse("error", { error: { type: "api_error", message: e.text } }))
          return ctl.close()
        case "stop":
          close()
          ctl.enqueue(sse("message_delta", { delta: { stop_reason: e.reason, stop_sequence: null }, usage: anthropicUsage(e.usage) }))
          ctl.enqueue(sse("message_stop", {}))
          return ctl.close()
      }
    },
    cancel() {
      it.return?.()
    },
  })
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

// reply answers the Messages request from Kiro's events: a stream of
// Messages' events, or one message. names gives back the caller's name of
// a tool Kiro was sent under another (toolNames).
export function reply(it, model, stream, names = new Map()) {
  const id = "msg_" + randomBytes(12).toString("hex")
  return stream ? streamed(it, id, model, names) : whole(it, id, model, names)
}
