// Trae: turning its events into what the answer is made of — text, reasoning, tool calls, token counts, the finish.
import { callId, NativeCalls } from "./native-calls.mjs"
import { eventName } from "./sse.mjs"
import { errorOf } from "./errors.mjs"
import { TextTools } from "./text-tools.mjs"
import { toolNamed, unwrapped } from "./tools.mjs"

// tokensOf maps Trae's token counts to OpenAI's
export function tokensOf(u) {
  if (!u || typeof u !== "object") return null
  const p = Number(u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? u.inputTokens ?? 0) || 0
  const c = Number(u.completion_tokens ?? u.output_tokens ?? u.completionTokens ?? u.outputTokens ?? 0) || 0
  if (!p && !c) return null
  return { prompt_tokens: p, completion_tokens: c, total_tokens: Number(u.total_tokens ?? u.totalTokens) || p + c }
}

// the events that carry the answer: output and message, and the names
// Trae has put a reply's text under otherwise (delta, or none at all);
// any other is queueing, metadata or timing
const ANSWER = new Set(["", "output", "message", "delta", "content", "text", "answer", "chunk", "output_delta", "message_delta"])

// finishOf is OpenAI's finish_reason for the one Trae's last event gives,
// "" for none it says or one it has no word for
export function finishOf(d) {
  const f = String(d?.finish_reason ?? d?.stop_reason ?? d?.finishReason ?? "").toLowerCase()
  if (["length", "max_tokens", "max_output_tokens", "max_length"].includes(f)) return "length"
  if (f === "content_filter" || f === "sensitive") return "content_filter"
  return ""
}

// Thoughts is the reasoning sent on so far: a piece Trae sends again (the
// same one twice in a row, or the reasoning so far, again or with more
// after it) sends only what is new
export class Thoughts {
  constructor() {
    this.all = ""
    this.last = ""
  }
  add(r) {
    const last = this.last
    this.last = r
    if (r === last && r.length >= 8) return ""
    if (this.all.length >= 16 && r.length >= 16 && this.all.endsWith(r)) return ""
    if (this.all.length >= 16 && r.startsWith(this.all)) r = r.slice(this.all.length)
    this.all += r
    return r
  }
}

// parts turns Trae's events into what the answer is made of: text,
// reasoning, tool calls, the token counts, the finish, or an error. tools
// are the request's, a call to one named otherwise going on under its name.
export async function* parts(events, tools = []) {
  const tt = new TextTools(tools)
  const nc = new NativeCalls()
  const th = new Thoughts()
  const call = (c) => {
    const name = toolNamed(c.name, tools)
    return { call: { ...c, name, arguments: unwrapped(c.arguments, name, tools) } }
  }
  // what the text tools took out of the text so far: its reasoning, text and calls, then the error that ends
  // the answer, if there is one (which the generator returns true for)
  const fromText = function* (r) {
    const t = r.reasoning && th.add(r.reasoning)
    if (t) yield { reasoning: t }
    if (r.text) yield { text: r.text }
    for (const c of r.calls) yield call({ ...c, id: callId() })
    if (r.error) {
      yield { error: r.error, code: null }
      return true
    }
    return false
  }
  let finish = ""
  for await (const { event, data } of events) {
    const name = eventName(event)
    const d = data && typeof data === "object" ? data : {}
    if (data === "[DONE]") break
    if (name === "error" || (name !== "output" && d.code && d.message && !d.response && !d.content)) {
      const e = errorOf(d)
      // (named for Trae CN, as it always was, whichever realm answered)
      yield { error: e.message || "Trae CN returned an error", code: e.code }
      return
    }
    if (name === "token_usage") {
      const u = tokensOf(d.usage ?? d)
      if (u) yield { usage: u }
      continue
    }
    if (name === "done" || name === "response_done" || name === "stream_done") {
      const u = tokensOf(d.usage)
      if (u) yield { usage: u }
      finish = finishOf(d) || finish
      break
    }
    if (!ANSWER.has(name)) continue
    const delta = d.delta && typeof d.delta === "object" ? d.delta : {}
    const reasoning = d.reasoning_content ?? d.reasoning ?? delta.reasoning_content ?? ""
    if (typeof reasoning === "string" && reasoning) {
      const r = th.add(reasoning)
      if (r) yield { reasoning: r }
    }
    let text = typeof d.response === "string" ? d.response : typeof d.content === "string" ? d.content : typeof delta.content === "string" ? delta.content : typeof d.delta === "string" ? d.delta : ""
    // the IDE's own progress notes, not the model's
    if (/^(Building prompt:|Completed building prompt)/.test(text)) text = ""
    if (text && (yield* fromText(tt.push(text)))) return
    for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) nc.push(tc)
    const u = tokensOf(d.usage)
    if (u) yield { usage: u }
    finish = finishOf(d) || finish
  }
  if (yield* fromText(tt.push("", true))) return
  for (const c of nc.take(tools)) yield call(c)
  if (finish) yield { finish }
}

// first reads events up to the first that is the answer's, so an answer
// that is only an error (signed out, out of credit, a model this account
// lacks) is known before anything is sent on
export async function first(it) {
  const held = []
  for (;;) {
    const n = await it.next()
    if (n.done) return { held, done: true }
    held.push(n.value)
    if (!n.value.usage) return { held, done: false }
  }
}

export async function* chain(held, it) {
  yield* held
  for (;;) {
    const n = await it.next()
    if (n.done) return
    yield n.value
  }
}
