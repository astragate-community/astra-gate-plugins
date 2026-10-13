// Qoder: turning its SSE reply back into the chat completion OpenAI's API gives, streamed or whole.
import { errorResponse, failure } from "./refusals.mjs"
import { Splitter } from "./toolcalls.mjs"
import { callId, hexID } from "./util.mjs"

async function* sseLines(body) {
  const dec = new TextDecoder()
  let buf = ""
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true })
    let n
    while ((n = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, n).trim()
      buf = buf.slice(n + 1)
    }
  }
  if (buf.trim()) yield buf.trim()
}

// usageOf is a chunk's usage as OpenAI gives it.
export const usageOf = (u) => ({
  prompt_tokens: u.prompt_tokens ?? 0,
  completion_tokens: u.completion_tokens ?? 0,
  total_tokens: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
  ...(u.prompt_tokens_details?.cached_tokens ? { prompt_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } } : {}),
  ...(u.completion_tokens_details?.reasoning_tokens ? { completion_tokens_details: { reasoning_tokens: u.completion_tokens_details.reasoning_tokens } } : {}),
})

// events turns Qoder's SSE into chat completion pieces: each data line's
// envelope has a "body" that is an OpenAI chunk, whose content may hold
// tool calls to lift out.
export async function* events(body) {
  const a = new Splitter()
  let index = -1 // the tool call being given
  let native = -1 // the native tool call being assembled
  const flushed = function* () {
    for (const f of a.flush()) if (f.text) yield { text: f.text }
  }
  let usage
  let fr = ""
  for await (const line of sseLines(body)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    let env
    try {
      env = JSON.parse(payload)
    } catch {
      continue
    }
    const inner = typeof env?.body === "string" ? env.body : ""
    if (env?.statusCodeValue != null && env.statusCodeValue !== 200) {
      yield { error: failure(Number(env.statusCodeValue), inner || payload) }
      return
    }
    if (inner.trim() === "[DONE]") break
    let chunk
    try {
      chunk = JSON.parse(inner)
    } catch {
      continue
    }
    const delta = chunk?.choices?.[0]?.delta ?? {}
    if (delta.reasoning_content) yield { reasoning: delta.reasoning_content }
    if (typeof delta.content === "string")
      for (const f of a.feed(delta.content)) {
        if (f.call) yield { tool: { index: ++index, id: callId(), name: f.call.name, args: f.call.args } }
        else if (f.text) yield { text: f.text }
      }
    // tool calls served the OpenAI way keep Qoder's id: a result answers it
    for (const tc of delta.tool_calls ?? []) {
      const i = Number(tc.index ?? 0)
      if (i !== native) {
        native = i
        yield* flushed()
        a.sawTool = true
        yield { tool: { index: ++index, id: tc.id || callId(), name: tc.function?.name ?? "", args: tc.function?.arguments ?? "" } }
      } else if (tc.function?.arguments) yield { args: { index, text: tc.function.arguments } }
    }
    fr = chunk?.choices?.[0]?.finish_reason || fr
    // the usage comes in a chunk of its own after the finish, with no
    // choices, as the built-in read it (qoder.go): every request was
    // counted as 0 tokens when the finish ended the reading
    if (chunk?.usage) usage = usageOf(chunk.usage)
  }
  yield* flushed()
  yield { stop: a.sawTool ? "tool_calls" : fr === "length" ? "length" : "stop", usage }
}

// toolCall is a lifted tool call as a chat completion's message holds it.
const toolCall = (t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } })

// answer turns Qoder's reply into the chat completion OpenAI's API gives.
// A failure before the answer keeps its status; one after it ends the
// stream with an error.
export async function answer(res, chat) {
  const id = "chatcmpl-" + hexID()
  const created = Math.floor(Date.now() / 1000)
  const it = events(res.body)
  const first = await it.next()
  if (first.value?.error) return errorResponse(first.value.error)
  if (first.done) return errorResponse({ status: 502, message: "Qoder ended without an answer" })

  if (!chat.stream) {
    const msg = { role: "assistant", content: "" }
    let reasoning = ""
    const calls = []
    let stop = "stop"
    let usage
    for (let r = first; !r.done; r = await it.next()) {
      const e = r.value
      if (e.error) return errorResponse(e.error)
      if (e.text) msg.content += e.text
      if (e.reasoning) reasoning += e.reasoning
      if (e.tool) calls.push(toolCall(e.tool))
      if (e.args) calls[calls.length - 1].function.arguments += e.args.text
      if (e.stop) [stop, usage] = [e.stop, e.usage]
    }
    if (reasoning) msg.reasoning_content = reasoning
    if (calls.length) msg.tool_calls = calls
    return Response.json({ id, object: "chat.completion", created, model: chat.model, choices: [{ index: 0, message: msg, finish_reason: stop }], ...(usage ? { usage } : {}) })
  }

  const enc = new TextEncoder()
  const chunk = (delta, finish_reason = null, extra = {}) =>
    enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: chat.model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`)
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
        ctl.enqueue(enc.encode("data: [DONE]\n\n"))
        return ctl.close()
      }
      const e = r.value
      if (e.text) ctl.enqueue(chunk({ content: e.text }))
      else if (e.reasoning) ctl.enqueue(chunk({ reasoning_content: e.reasoning }))
      else if (e.tool) ctl.enqueue(chunk({ tool_calls: [{ index: e.tool.index, ...toolCall(e.tool) }] }))
      else if (e.args) ctl.enqueue(chunk({ tool_calls: [{ index: e.args.index, function: { arguments: e.args.text } }] }))
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
