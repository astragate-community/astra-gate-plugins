// Reading /alpha/generate's reply (a JSON object a line) as chat completion pieces
import { randomBytes } from "node:crypto"
import { parseArgs } from "./request.mjs"
import { streamError } from "./refusals.mjs"

// lines reads the reply a JSON object a line.
async function* lines(body) {
  const dec = new TextDecoder()
  let buf = ""
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true })
    let n
    while ((n = buf.indexOf("\n")) >= 0) {
      const s = buf.slice(0, n).trim()
      buf = buf.slice(n + 1)
      if (s) yield s
    }
  }
  if (buf.trim()) yield buf.trim()
}

const FINISH = { "tool-calls": "tool_calls", length: "length", "content-filter": "content_filter" }

// CUT_SHORT_NOTE ends a streamed reply Command Code stopped sending
// before its finish line (as zen-free does, #91): magpie's gateway can't go
// on with a Chat Completions reply, and failing it would throw away what
// the client was already shown.
export const CUT_SHORT_NOTE = "(The reply was cut short: Command Code closed the stream before it finished. Ask again to go on.)"

// events turns the reply's lines into chat completion pieces: text,
// reasoning, whole tool calls, then the finish with the usage. A reply
// with no finish line was cut short: { cut } when it said something
// (its tool calls come whole, never half written), else an error.
export async function* events(body) {
  let tools = 0
  let cacheWrite = 0
  let said = false
  let wrote = false
  for await (const s of lines(body)) {
    let l
    try {
      l = JSON.parse(s)
    } catch {
      continue
    }
    switch (l.type) {
      case "text-delta":
        if (l.text) {
          said = wrote = true
          yield { text: l.text }
        }
        break
      case "reasoning-delta":
        if (l.text) {
          said = true
          yield { reasoning: l.text }
        }
        break
      case "tool-call": {
        if (l.providerExecuted) break // run by the server, its result beside it
        let input = l.input ?? l.args
        input = typeof input === "string" ? parseArgs(input) : input ?? {}
        said = true
        yield { tool: { index: tools++, id: l.toolCallId || "call_" + randomBytes(12).toString("hex"), name: l.toolName, args: JSON.stringify(input) } }
        break
      }
      case "cache-write-tokens":
        cacheWrite = Math.max(cacheWrite, l.cacheWriteTokens ?? 0)
        break
      case "finish": {
        const t = l.totalUsage ?? {}
        const d = t.inputTokenDetails ?? {}
        let stop = FINISH[l.finishReason] ?? "stop"
        if (tools > 0 && stop === "stop") stop = "tool_calls"
        const input = t.inputTokens ?? 0 // the AI SDK's counts the cache in it, as OpenAI's does
        yield {
          stop,
          usage: {
            prompt_tokens: input,
            completion_tokens: t.outputTokens ?? 0,
            total_tokens: input + (t.outputTokens ?? 0),
            prompt_tokens_details: { cached_tokens: d.cacheReadTokens ?? 0, cache_write_tokens: Math.max(cacheWrite, d.cacheWriteTokens ?? 0) },
            completion_tokens_details: { reasoning_tokens: t.outputTokenDetails?.reasoningTokens ?? 0 },
          },
        }
        return
      }
      case "abort":
        yield { stop: "stop" }
        return
      case "error":
        yield { error: streamError(l.error) }
        return
    }
  }
  const error = { status: 502, message: "the reply ended before it was complete" }
  yield said ? { cut: tools > 0 ? "tool_calls" : "stop", wrote, error } : { error }
}
