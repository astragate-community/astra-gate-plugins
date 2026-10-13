// The answer as OpenAI's chat completion, from the Run's pieces: one JSON body, or a server-sent event stream.
import { randomBytes } from "node:crypto"
import { cursorError } from "./errors.mjs"
import { enc } from "./constants.mjs"

// replyOf answers a Run's pieces (events: text, reasoning, tool calls, the stop with its usage, an error) as a
// chat completion of the model, streamed or not.
export async function replyOf(it, model, streamed) {
  const cid = "chatcmpl-" + randomBytes(12).toString("hex")
  const created = Math.floor(Date.now() / 1000)

  if (!streamed) {
    const msg = { role: "assistant", content: "" }
    let reasoning = ""
    const calls = []
    let stop = "stop"
    let usage
    for await (const e of it) {
      if (e.error) return cursorError(e.error)
      if (e.text) msg.content += e.text
      if (e.reasoning) reasoning += e.reasoning
      if (e.tool) calls.push({ id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: e.tool.args } })
      if (e.stop) [stop, usage] = [e.stop, e.usage]
    }
    if (reasoning) msg.reasoning_content = reasoning
    if (calls.length) msg.tool_calls = calls
    return Response.json({ id: cid, object: "chat.completion", created, model, choices: [{ index: 0, message: msg, finish_reason: stop }], ...(usage ? { usage } : {}) })
  }

  const chunk = (delta, finish_reason = null, extra = {}) =>
    enc.encode(`data: ${JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`)
  let began = false
  const stream = new ReadableStream({
    async pull(ctl) {
      const r = await it.next()
      if (!began) {
        began = true
        ctl.enqueue(chunk({ role: "assistant", content: "" }))
      }
      if (r.done) {
        ctl.enqueue(enc.encode("data: [DONE]\n\n"))
        return ctl.close()
      }
      const e = r.value
      if (e.text) ctl.enqueue(chunk({ content: e.text }))
      else if (e.reasoning) ctl.enqueue(chunk({ reasoning_content: e.reasoning }))
      else if (e.tool) ctl.enqueue(chunk({ tool_calls: [{ index: e.tool.index, id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: e.tool.args } }] }))
      else if (e.stop) ctl.enqueue(chunk({}, e.stop, e.usage ? { usage: e.usage } : {}))
      else if (e.error) {
        ctl.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: e.error.message, code: e.error.status } })}\n\n`))
        ctl.close()
      }
    },
    cancel() {
      it.return?.()
    },
  })
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
}
