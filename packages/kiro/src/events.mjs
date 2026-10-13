// Kiro: the reply as events — Kiro's AWS event stream, read into text, thinking, tool calls and a stop.
import { exception, frames } from "./eventstream.mjs"
import { windows } from "./models.mjs"
import { ThinkParser } from "./think.mjs"

const ERROR_EVENTS = ["error", "throttlingError", "validationError", "serviceUnavailableError", "internalServerException"]

// stopReason is why the reply stopped, as Messages says it.
export function stopReason(tools, stop) {
  if (tools > 0) return "tool_use"
  if (/^max_tokens$/i.test(stop)) return "max_tokens"
  if (/^content_filtered$/i.test(stop)) return "refusal"
  return "end_turn"
}

// settleUsage fills in what Kiro left out of the usage: it says how full the
// context is rather than how many tokens (against the model's window), and
// for the output, `said` characters are counted at four to a token.
export function settleUsage(usage, pct, window, said) {
  if (!usage.input && pct > 0 && window > 0) usage.input = Math.floor((pct / 100) * window)
  if (!usage.output) usage.output = Math.floor((said + 3) / 4)
  return usage
}

// events turns Kiro's reply into events: text, thinking, tool calls (the
// arguments in pieces), then the usage and why it stopped — or an error.
export async function* events(body, model, budget) {
  const think = new ThinkParser()
  let tool = ""
  let tools = 0
  let stop = ""
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let pct = 0
  let said = 0
  let failed = ""
  const dec = new TextDecoder()
  try {
    for await (const f of frames(body)) {
      const type = f.headers[":message-type"]
      if (type === "exception" || type === "error") {
        failed = exception(f.headers[":exception-type"] || f.headers[":error-code"], f.payload)
        break
      }
      let m
      try {
        m = JSON.parse(dec.decode(f.payload))
      } catch {
        continue
      }
      const kind = f.headers[":event-type"]
      if (kind === "assistantResponseEvent") {
        const text = typeof m.content === "string" ? m.content : ""
        said += text.length
        if (budget) yield* think.feed(text)
        else if (text) yield { kind: "text", text }
      } else if (kind === "reasoningContentEvent") {
        if (m.text) {
          said += m.text.length
          yield { kind: "think", text: m.text }
        } else if (m.signature) yield { kind: "sig", text: m.signature }
      } else if (kind === "toolUseEvent") {
        if (m.toolUseId && m.toolUseId !== tool) {
          yield* think.end() // the text before a call is all said
          tool = m.toolUseId
          tools++
          yield { kind: "toolStart", id: m.toolUseId, name: m.name ?? "" }
        }
        if (m.input !== undefined && m.input !== null) {
          // the arguments come as text, or as an object (an empty one says nothing)
          const isText = typeof m.input === "string"
          const s = isText ? m.input : JSON.stringify(m.input)
          if (isText ? s : s !== "{}") yield { kind: "toolArgs", text: s }
          said += s.length
        }
      } else if (kind === "metadataEvent" || kind === "messageMetadataEvent") {
        if (m.stopReason) stop = m.stopReason
        const tu = m.tokenUsage
        if (tu && typeof tu === "object") {
          usage.input += tu.uncachedInputTokens || tu.inputTokens || 0
          usage.output += tu.outputTokens || 0
          usage.cacheRead += tu.cacheReadInputTokens || 0
          usage.cacheWrite += tu.cacheWriteInputTokens || 0
          if (tu.contextUsagePercentage > 0) pct = tu.contextUsagePercentage
        }
      } else if (kind === "contextUsageEvent") {
        if (m.contextUsagePercentage > 0) pct = m.contextUsagePercentage
      } else if (ERROR_EVENTS.includes(kind)) {
        failed = exception(kind, f.payload)
        break
      }
    }
  } catch (e) {
    if (e?.name !== "AbortError") failed = "the reply broke off: " + e.message
  }
  yield* think.end()
  if (failed) {
    yield { kind: "error", text: failed }
    return
  }
  yield { kind: "stop", reason: stopReason(tools, stop), usage: settleUsage(usage, pct, windows.get(model) ?? 0, said) }
}
