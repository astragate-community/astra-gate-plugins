// Kiro: the reply — Kiro's AWS event stream (framed by the host: reply.framing "aws-eventstream") as Anthropic's Messages,
// one stream event or one message at a time. The state of one reply lives in ctx.state (host-provided, per reply).
import { crypto } from "astra"
import { statusWords, tryJSON } from "./errors.js"
import { windows } from "./models.js"
import { ThinkParser } from "./think.js"
import { callerToolName } from "./tools.js"

const ERROR_EVENTS = ["error", "throttlingError", "validationError", "serviceUnavailableError", "internalServerException"]

// failure is the status and message for an error Kiro answered with: {"message": "...", "reason": "..."}.
export function failure(status, body) {
  let msg = String(body ?? "").trim()
  const e = tryJSON(body)
  if (e?.message) msg = e.message + (e.reason ? ` (${e.reason})` : "")
  msg ||= statusWords(status)
  if (msg.includes("CONTENT_LENGTH_EXCEEDS_THRESHOLD") || msg.toLowerCase().includes("input is too long"))
    return { status: 400, message: "input is too long for the model's context: " + msg }
  if (msg.includes("INSUFFICIENT_MODEL_CAPACITY")) return { status: 503, message: msg }
  if (msg.includes("MONTHLY_REQUEST_COUNT") || msg.includes("USAGE_LIMIT")) return { status: 429, message: "usage limit reached: " + msg }
  return { status, message: msg }
}

// how a vendor says "out of quota" or "slow down" (magpie's internal/gateway/fallback.go)
const QUOTA_WORDS = /quota|insufficient|balance|credit|billing|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i
/** An error before any of the answer: a 429 when it reads as a quota or rate limit, else a 502 (so another account can take over). */
const failedBefore = (text) => ({ status: QUOTA_WORDS.test(text) ? 429 : 502, message: text })

// exception is what an error in the stream says.
function exception(kind, f) {
  const e = f.json && typeof f.json === "object" ? f.json : {}
  const raw = typeof f.text === "string" ? f.text.trim() : ""
  let msg = e.message || e.Message || raw
  if (e.reason) msg += ` (${e.reason})`
  if (String(kind).toLowerCase().includes("throttl")) return "rate limited: " + msg
  return kind ? `${kind}: ${msg}` : msg
}

// stopReason is why the reply stopped, as Messages says it.
export function stopReason(tools, stop) {
  if (tools > 0) return "tool_use"
  if (/^max_tokens$/i.test(stop)) return "max_tokens"
  if (/^content_filtered$/i.test(stop)) return "refusal"
  return "end_turn"
}

// settleUsage fills in what Kiro left out of the usage: it says how full the context is rather than how many tokens
// (against the model's window), and for the output, `said` characters are counted at four to a token.
export function settleUsage(usage, pct, window, said) {
  if (!usage.input && pct > 0 && window > 0) usage.input = Math.floor((pct / 100) * window)
  if (!usage.output) usage.output = Math.floor((said + 3) / 4)
  return usage
}

export const anthropicUsage = (u) => ({
  input_tokens: u.input,
  output_tokens: u.output,
  cache_read_input_tokens: u.cacheRead,
  cache_creation_input_tokens: u.cacheWrite,
})
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function fresh(ctx) {
  const s = ctx.state
  if (s.kiro) return s.kiro
  return (s.kiro = {
    think: new ThinkParser(), tool: "", tools: 0, stop: "", pct: 0, said: 0, usage: { ...NO_USAGE },
    id: "msg_" + crypto.randomUUID().replaceAll("-", "").slice(0, 24),
    done: false, failed: "", started: false, index: -1, open: "", content: [],
  })
}

// readEvents turns one of Kiro's frames into events: text, thinking, tool calls (arguments in pieces), usage; or an error.
function readEvents(k, f, model) {
  const type = f.headers?.[":message-type"]
  if (type === "exception" || type === "error") {
    k.failed = exception(f.headers[":exception-type"] || f.headers[":error-code"], f)
    return []
  }
  const m = f.json && typeof f.json === "object" ? f.json : null
  if (!m) return []
  const kind = f.headers?.[":event-type"]
  const out = []
  if (kind === "assistantResponseEvent") {
    const text = typeof m.content === "string" ? m.content : ""
    k.said += text.length
    out.push(...k.think.feed(text))
  } else if (kind === "reasoningContentEvent") {
    if (m.text) {
      k.said += m.text.length
      out.push({ kind: "think", text: m.text })
    } else if (m.signature) out.push({ kind: "sig", text: m.signature })
  } else if (kind === "toolUseEvent") {
    if (m.toolUseId && m.toolUseId !== k.tool) {
      out.push(...k.think.end()) // the text before a call is all said
      k.tool = m.toolUseId
      k.tools++
      out.push({ kind: "toolStart", id: m.toolUseId, name: m.name ?? "" })
    }
    if (m.input !== undefined && m.input !== null) {
      // the arguments come as text, or as an object (an empty one says nothing)
      const isText = typeof m.input === "string"
      const s = isText ? m.input : JSON.stringify(m.input)
      if (isText ? s : s !== "{}") out.push({ kind: "toolArgs", text: s })
      k.said += s.length
    }
  } else if (kind === "metadataEvent" || kind === "messageMetadataEvent") {
    if (m.stopReason) k.stop = m.stopReason
    const tu = m.tokenUsage
    if (tu && typeof tu === "object") {
      k.usage.input += tu.uncachedInputTokens || tu.inputTokens || 0
      k.usage.output += tu.outputTokens || 0
      k.usage.cacheRead += tu.cacheReadInputTokens || 0
      k.usage.cacheWrite += tu.cacheWriteInputTokens || 0
      if (tu.contextUsagePercentage > 0) k.pct = tu.contextUsagePercentage
    }
  } else if (kind === "contextUsageEvent") {
    if (m.contextUsagePercentage > 0) k.pct = m.contextUsagePercentage
  } else if (ERROR_EVENTS.includes(kind)) k.failed = exception(kind, f)
  return out
}

const sse = (type, data) => ({ event: type, data: { type, ...data } })

// hello opens the stream (message_start), once, with the first thing that is said.
function hello(k, ctx, out) {
  if (k.started) return
  k.started = true
  out.push(sse("message_start", { message: { id: k.id, type: "message", role: "assistant", model: ctx.request.model, content: [], stop_reason: null,
    stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }))
}

// toOutput renders events: Messages' stream events, or (non-streaming) blocks gathered in k.content.
function toOutput(k, ctx, events) {
  const out = []
  const stream = ctx.request.stream
  const close = () => {
    if (k.open) out.push(sse("content_block_stop", { index: k.index }))
    k.open = ""
  }
  const begin = (kind, block) => {
    close()
    k.index++
    k.open = kind
    out.push(sse("content_block_start", { index: k.index, content_block: block }))
  }
  for (const e of events) {
    if (!stream) {
      const last = k.content.at(-1)
      if (e.kind === "text") last?.type === "text" ? (last.text += e.text) : k.content.push({ type: "text", text: e.text })
      else if (e.kind === "think") last?.type === "thinking" ? (last.thinking += e.text) : k.content.push({ type: "thinking", thinking: e.text, signature: "" })
      else if (e.kind === "sig") { if (last?.type === "thinking") last.signature += e.text }
      else if (e.kind === "toolStart") k.content.push({ type: "tool_use", id: e.id, name: callerToolName(e.name), input: "" })
      else if (e.kind === "toolArgs") { if (last?.type === "tool_use") last.input += e.text }
      continue
    }
    hello(k, ctx, out)
    if (e.kind === "text") {
      if (k.open !== "text") begin("text", { type: "text", text: "" })
      out.push(sse("content_block_delta", { index: k.index, delta: { type: "text_delta", text: e.text } }))
    } else if (e.kind === "think") {
      if (k.open !== "thinking") begin("thinking", { type: "thinking", thinking: "", signature: "" })
      out.push(sse("content_block_delta", { index: k.index, delta: { type: "thinking_delta", thinking: e.text } }))
    } else if (e.kind === "sig") {
      if (k.open === "thinking") out.push(sse("content_block_delta", { index: k.index, delta: { type: "signature_delta", signature: e.text } }))
    } else if (e.kind === "toolStart") begin("tool", { type: "tool_use", id: e.id, name: callerToolName(e.name), input: {} })
    else if (e.kind === "toolArgs") {
      if (k.open === "tool") out.push(sse("content_block_delta", { index: k.index, delta: { type: "input_json_delta", partial_json: e.text } }))
    }
  }
  return out
}

// whole is the one message of a non-streaming reply, each call's arguments read.
function whole(k, ctx, reason, usage) {
  for (const b of k.content)
    if (b.type === "tool_use") {
      try {
        b.input = b.input ? JSON.parse(b.input) : {}
      } catch {
        b.input = {}
      }
    }
  return { id: k.id, type: "message", role: "assistant", model: ctx.request.model, content: k.content, stop_reason: reason, stop_sequence: null, usage: anthropicUsage(usage) }
}

// a failed reply: before any of it was said, a status (so another account can take over); after, what was said, ended
function failNow(k, ctx) {
  k.done = true
  const stream = ctx.request.stream
  if (!(stream ? k.started : k.content.length)) return { $error: failedBefore(k.failed) }
  if (!stream) return whole(k, ctx, "end_turn", NO_USAGE)
  const out = toOutput(k, ctx, k.think.end())
  if (k.open) out.push(sse("content_block_stop", { index: k.index }))
  k.open = ""
  out.push(sse("error", { error: { type: "api_error", message: k.failed } }))
  return out
}

export const transformResponse = {
  // an error answer is Kiro's own words as a status; a 401 / 403 passes through for refresh (and failover) to see
  start(res) {
    if (res.status < 400 || res.status === 401 || res.status === 403) return
    return { error: failure(res.status, String(res.body ?? "").slice(0, 1 << 20)) }
  },

  frame(f, ctx) {
    const k = fresh(ctx)
    if (k.done) return
    const events = readEvents(k, f, ctx.request.model)
    if (k.failed) {
      // a failure takes effect after what this very frame said before it (events come first)
      const said = toOutput(k, ctx, events)
      const fail = failNow(k, ctx)
      return [...said, ...(Array.isArray(fail) ? fail : [fail])]
    }
    return toOutput(k, ctx, events)
  },

  end(ctx) {
    const k = fresh(ctx)
    if (k.done) return
    const out = toOutput(k, ctx, k.think.end())
    const usage = settleUsage(k.usage, k.pct, windows.get(ctx.request.model) ?? 0, k.said)
    const reason = stopReason(k.tools, k.stop)
    if (!ctx.request.stream) return whole(k, ctx, reason, usage)
    hello(k, ctx, out)
    if (k.open) out.push(sse("content_block_stop", { index: k.index }))
    k.open = ""
    out.push(sse("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: anthropicUsage(usage) }))
    out.push(sse("message_stop", {}))
    return out
  },
}
