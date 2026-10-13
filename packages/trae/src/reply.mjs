// Trae: the answer as an OpenAI chat completion — one body, or a stream.
import { randomBytes } from "node:crypto"
import { failure } from "./errors.mjs"

// completion is the answer as an OpenAI chat completion: a stream, or one body
// abort, when given, lets the answer's reader close Trae's connection the
// moment the agent goes away (a tool call made, a request cancelled): a
// generator's return can't break a read that is already waiting, so the
// fetch itself is what has to be stopped
export async function completion(req, it, abort, site) {
  const id = "chatcmpl-" + randomBytes(12).toString("hex")
  const created = Math.floor(Date.now() / 1000)
  const model = req.model
  if (!req.stream) {
    let text = ""
    let reasoning = ""
    const calls = []
    let usage = null
    let finish = ""
    for await (const p of it) {
      if (p.error) return failure(site, 502, p.code, p.error)
      if (p.text) text += p.text
      if (p.reasoning) reasoning += p.reasoning
      if (p.call) calls.push(p.call)
      if (p.usage) usage = p.usage
      if (p.finish) finish = p.finish
    }
    const message = { role: "assistant", content: text || (calls.length ? null : "") }
    if (reasoning) message.reasoning_content = reasoning
    if (calls.length) message.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }))
    const body = { id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : finish || "stop" }] }
    if (usage) body.usage = usage
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }
  const enc = new TextEncoder()
  const chunk = (delta, finish = null, extra = {}) => enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`)
  // a reply that failed (an error event, or Trae's stream breaking off)
  // ends with the error and [DONE], not a finish that says it stopped; the
  // stream is closed whatever happens, and an agent that goes away stops
  // the reading of Trae's. The message names Trae CN, as it always did,
  // whichever realm answered.
  const error = (message, code = null) => enc.encode(`data: ${JSON.stringify({ error: { message: `Trae CN: ${message}`, type: "api_error", code } })}\n\n`)
  let gone = false
  const stream = new ReadableStream({
    async start(ctl) {
      let calls = 0
      let usage = null
      let finish = ""
      let failed = false
      const put = (b) => {
        if (!gone) ctl.enqueue(b)
      }
      try {
        put(chunk({ role: "assistant", content: "" }))
        for await (const p of it) {
          if (gone) break
          if (p.error) {
            put(error(p.error, p.code ?? null))
            failed = true
            break
          }
          if (p.text) put(chunk({ content: p.text }))
          if (p.reasoning) put(chunk({ reasoning_content: p.reasoning }))
          if (p.call) put(chunk({ tool_calls: [{ index: calls++, id: p.call.id, type: "function", function: { name: p.call.name, arguments: p.call.arguments } }] }))
          if (p.usage) usage = p.usage
          if (p.finish) finish = p.finish
        }
        if (!failed) {
          put(chunk({}, calls ? "tool_calls" : finish || "stop"))
          if (usage) put(enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`))
        }
      } catch (e) {
        try {
          put(error(e?.message ?? e))
        } catch {}
      }
      try {
        put(enc.encode("data: [DONE]\n\n"))
        if (!gone) ctl.close()
      } catch {}
    },
    cancel() {
      gone = true
      abort?.()
      it.return?.()
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}
