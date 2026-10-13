// Answering a chat completion through /alpha/generate, as a chat completion again (whole, or streamed)
import { randomBytes } from "node:crypto"
import { API } from "./constants.mjs"
import { generateBody, generateHeaders } from "./request.mjs"
import { CUT_SHORT_NOTE, events } from "./response.mjs"
import { failure, refusal } from "./refusals.mjs"

const enc = new TextEncoder()
const sse = (data) => enc.encode(`data: ${JSON.stringify(data)}\n\n`)
const DONE = enc.encode("data: [DONE]\n\n")

// the whole reply of a chat that didn't ask for a stream, or the error it ended in; `first` is the piece already read
async function collect(it, first, head) {
  const msg = { role: "assistant", content: "" }
  let reasoning = ""
  const calls = []
  let stop = "stop"
  let usage
  for (let r = first; !r.done; r = await it.next()) {
    const e = r.value
    if (e.error) return refusal(e.error)
    if (e.text) msg.content += e.text
    if (e.reasoning) reasoning += e.reasoning
    if (e.tool) calls.push({ id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: e.tool.args } })
    if (e.stop) [stop, usage] = [e.stop, e.usage]
  }
  if (reasoning) msg.reasoning_content = reasoning
  if (calls.length) msg.tool_calls = calls
  return Response.json({ id: head.id, object: "chat.completion", created: head.created, model: head.model, choices: [{ index: 0, message: msg, finish_reason: stop }], ...(usage ? { usage } : {}) })
}

// the reply as a chat completion's event stream
function streamOf(it, first, head) {
  const chunk = (delta, finish_reason = null, extra = {}) =>
    sse({ id: head.id, object: "chat.completion.chunk", created: head.created, model: head.model, choices: [{ index: 0, delta, finish_reason }], ...extra })
  let pending = first
  let began = false
  const stream = new ReadableStream({
    async pull(ctl) {
      const r = pending ?? (await it.next())
      pending = null
      if (!began) {
        began = true
        ctl.enqueue(chunk({ role: "assistant", content: "" }))
      }
      if (r.done) {
        ctl.enqueue(DONE)
        return ctl.close()
      }
      const e = r.value
      if (e.text) ctl.enqueue(chunk({ content: e.text }))
      else if (e.reasoning) ctl.enqueue(chunk({ reasoning_content: e.reasoning }))
      else if (e.tool) ctl.enqueue(chunk({ tool_calls: [{ index: e.tool.index, id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: e.tool.args } }] }))
      else if (e.stop) ctl.enqueue(chunk({}, e.stop, e.usage ? { usage: e.usage } : {}))
      else if (e.cut) {
        // the client has its start: a shorter turn that says so, not a lost one
        ctl.enqueue(chunk({ content: (e.wrote ? "\n\n" : "") + CUT_SHORT_NOTE }))
        ctl.enqueue(chunk({}, e.cut))
        ctl.enqueue(DONE)
        ctl.close()
      } else if (e.error) {
        ctl.enqueue(sse({ error: { message: e.error.message, code: e.error.status } }))
        ctl.close()
      }
    },
    cancel() {
      it.return?.()
    },
  })
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}

// generate answers a chat completion through /alpha/generate.
export async function generate(key, chat, signal, place) {
  const res = await fetch(API + "/alpha/generate", {
    method: "POST",
    headers: generateHeaders(key),
    body: JSON.stringify(generateBody(chat, place)),
    signal,
  })
  if (!res.ok) return refusal(failure(res.status, (await res.text()).slice(0, 1 << 20)))
  const head = { id: "chatcmpl-" + randomBytes(12).toString("hex"), created: Math.floor(Date.now() / 1000), model: chat.model }
  const it = events(res.body)
  // the first piece before the answer's status: a reply that fails
  // straight away keeps its status
  const first = await it.next()
  if (first.value?.error) return refusal(first.value.error)
  return chat.stream ? streamOf(it, first, head) : collect(it, first, head)
}
