// Answering a chat completion through GetChatMessage: the request sent, Devin's reply frames turned into chat
// completion pieces, and those as one response or a stream of chunks.
import { randomBytes } from "node:crypto"
import { KEPT, errorResponse } from "@astragate-community/plugin-kit"
import { CHAT_RPC } from "./constants.mjs"
import { dec, enc, fields, frame, frames } from "./protobuf.mjs"
import { failure } from "./refusals.mjs"
import { build } from "./request.mjs"
import { effortOf, variantFor } from "./variants.mjs"
import { outID } from "./tools.mjs"

// A failure as the built-in answered it. None marks the account lapsed: the
// built-in's 401s (a key Devin turned away, none to send) were answered
// without touching the account, so each says X-Magpie-Sign-In: kept — as a
// success does, which cleared nothing either (the kit's errorResponse keeps
// it by default).
export const refusal = ({ status, message }) => errorResponse({ status, message, type: "devin_error" })

// events turns the reply's frames into chat completion pieces: text,
// reasoning, each tool call opened with its id and name, its arguments in
// pieces after, then the finish with the usage.
export async function* events(it) {
  let tools = -1
  let stop = 0
  let said = 0
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  for (;;) {
    let r
    try {
      r = await it.next()
    } catch (e) {
      yield { error: { status: 502, message: "the reply broke off: " + e.message } }
      return
    }
    if (r.done) break
    const f = r.value
    if (f.end) {
      const e = failure(200, dec.decode(f.data))
      if (e.status >= 300) {
        yield { error: e }
        return
      }
      break
    }
    for (const x of fields(f.data)) {
      if (x.num === 3 && x.wire === 2 && x.data.length) {
        said += x.data.length
        yield { text: dec.decode(x.data) }
      } else if (x.num === 9 && x.wire === 2 && x.data.length) {
        said += x.data.length
        yield { reasoning: dec.decode(x.data) }
      } else if (x.num === 6 && x.wire === 2) {
        let id = ""
        let name = ""
        let args = ""
        for (const g of fields(x.data)) {
          if (g.num === 1) id = dec.decode(g.data ?? new Uint8Array())
          else if (g.num === 2) name = dec.decode(g.data ?? new Uint8Array())
          else if (g.num === 3) args += dec.decode(g.data ?? new Uint8Array())
        }
        if (name) {
          tools++
          yield { tool: { index: tools, id: id ? outID(id) : "call_" + randomBytes(12).toString("hex"), name } }
        }
        if (args && tools >= 0) yield { args: { index: tools, text: args } }
      } else if (x.num === 5 && x.wire === 0) stop = x.n
      else if (x.num === 7 && x.wire === 2) {
        for (const g of fields(x.data)) {
          if (g.wire !== 0 || !g.n) continue
          if (g.num === 2) usage.input = g.n
          else if (g.num === 3) usage.output = g.n
          else if (g.num === 4) usage.cacheWrite = g.n
          else if (g.num === 5) usage.cacheRead = g.n
        }
      }
    }
  }
  if (!usage.output) usage.output = Math.floor((said + 3) / 4)
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  yield {
    stop: tools >= 0 || stop === 10 ? "tool_calls" : stop === 3 ? "length" : "stop",
    usage: {
      prompt_tokens: prompt,
      completion_tokens: usage.output,
      total_tokens: prompt + usage.output,
      prompt_tokens_details: { cached_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite },
    },
  }
}

// the pieces as one chat.completion response, or the refusal that came instead
async function wholeReply(it, head) {
  const msg = { role: "assistant", content: "" }
  let reasoning = ""
  const calls = []
  let stop = "stop"
  let usage
  for await (const e of it) {
    if (e.error) return refusal(e.error)
    if (e.text) msg.content += e.text
    if (e.reasoning) reasoning += e.reasoning
    if (e.tool) calls.push({ id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: "" } })
    if (e.args) calls[e.args.index].function.arguments += e.args.text
    if (e.stop) [stop, usage] = [e.stop, e.usage]
  }
  if (reasoning) msg.reasoning_content = reasoning
  if (calls.length) msg.tool_calls = calls
  return Response.json({ id: head.id, object: "chat.completion", created: head.created, model: head.model, choices: [{ index: 0, message: msg, finish_reason: stop }], usage }, { headers: KEPT })
}

// the pieces as a stream of chat.completion.chunk events
function streamedReply(it, head) {
  const chunk = (delta, finish_reason = null, extra = {}) =>
    enc.encode(`data: ${JSON.stringify({ id: head.id, object: "chat.completion.chunk", created: head.created, model: head.model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`)
  let began = false
  const stream = new ReadableStream({
    async pull(ctl) {
      if (!began) {
        began = true
        ctl.enqueue(chunk({ role: "assistant", content: "" }))
      }
      const r = await it.next()
      if (r.done) {
        ctl.enqueue(enc.encode("data: [DONE]\n\n"))
        return ctl.close()
      }
      const e = r.value
      if (e.text) ctl.enqueue(chunk({ content: e.text }))
      else if (e.reasoning) ctl.enqueue(chunk({ reasoning_content: e.reasoning }))
      else if (e.tool) ctl.enqueue(chunk({ tool_calls: [{ index: e.tool.index, id: e.tool.id, type: "function", function: { name: e.tool.name, arguments: "" } }] }))
      else if (e.args) ctl.enqueue(chunk({ tool_calls: [{ index: e.args.index, function: { arguments: e.args.text } }] }))
      else if (e.stop) ctl.enqueue(chunk({}, e.stop, { usage: e.usage }))
      else if (e.error) {
        ctl.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: e.error.message, code: e.error.status } })}\n\n`))
        ctl.close()
      }
    },
    cancel() {
      it.return?.()
    },
  })
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...KEPT } })
}

// complete answers a chat completion through GetChatMessage.
export async function complete({ key, server, families }, chat, signal) {
  const uid = variantFor(families, chat.model, effortOf(chat.reasoning_effort))
  let res
  try {
    res = await fetch(server + CHAT_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/connect+proto", "Connect-Protocol-Version": "1", Authorization: "Basic " + key },
      body: frame(build(chat, uid, key)),
      signal,
    })
  } catch (e) {
    return refusal({ status: 502, message: e.message })
  }
  if (!res.ok) return refusal(failure(res.status, (await res.text()).slice(0, 1 << 20)))
  // an error comes as the stream's end, before anything else: read that
  // far so it is answered with its own status
  const fr = frames(res.body)
  let first
  try {
    first = await fr.next()
  } catch (e) {
    return refusal({ status: 502, message: "the reply broke off: " + e.message })
  }
  if (first.done) return refusal({ status: 502, message: "the reply broke off: EOF" })
  if (first.value.end) {
    const e = failure(200, dec.decode(first.value.data))
    return refusal(e.status < 300 ? { status: 502, message: "an empty reply" } : e)
  }
  const it = events(
    (async function* () {
      yield first.value
      yield* fr
    })(),
  )
  const head = { id: "chatcmpl-" + randomBytes(12).toString("hex"), created: Math.floor(Date.now() / 1000), model: chat.model }
  return chat.stream ? streamedReply(it, head) : wholeReply(it, head)
}
