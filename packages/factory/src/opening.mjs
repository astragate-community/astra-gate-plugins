// Factory: opening an OpenAI-route request as droid does (the system prompt's first line).
import { bodyText } from "./body.mjs"
import { rewrite } from "./rewrite.mjs"

// opening as droid
//
// Factory takes a subscription's model requests only from Droid (magpie
// #242, #506): the same account's GPT, Grok and GLM answered Droid every
// time and refused Codex, Grok Build and Claude Code every time, on the same
// models, efforts, endpoint and headers, the body the only difference. Every
// request droid sends opens its system prompt with one line (droid 0.231.0:
// its system blocks are [that line, the agent's prompt, …], sent as
// Responses' instructions joined with "\n", and on chat completions as one
// system message first, joined the same way). So another agent's request to
// /api/llm/o opens with the line too, as the built-in's factoryDroidBody
// (internal/provider/factory_client.go) has it. Anthropic's Messages
// (/api/llm/a) goes through anthropic-request.mjs, which adapts fixed client metadata.
// A native Droid request goes on byte for byte.

export const DROID_LINE = "You are Droid, an AI software engineering agent built by Factory."

// pi (@earendil-works/pi-coding-agent 1.0.4) opens its system prompt with
// a sentence Factory refuses whole, on the OpenAI and Anthropic routes
// alike (yetone/magpie#952): either half of it passes, and pi's full
// request with the sentence cut to "You are an expert coding assistant."
// is answered. Only that sentence, at the start of a line of a system or
// developer prompt, changes; the rest of pi's prompt goes on as it is.
const PI_OPENING = /(^|\n)You are an expert coding assistant operating inside pi, a coding agent harness\./
const PI_COMPAT = "You are an expert coding assistant."
export function clientOpening(text) {
  return typeof text === "string" ? text.replace(PI_OPENING, (_, at) => at + PI_COMPAT) : text
}

// pi turns a compaction, and a branch it came back from, into a user
// message of one text: a fixed sentence, then the summary in <summary> tags
// (pi-coding-agent 1.0.4 and 1.1.0, dist/core/messages.js:
// COMPACTION_SUMMARY_PREFIX and BRANCH_SUMMARY_PREFIX). Factory refuses the
// compaction sentence whole (yetone/magpie#1316): after a compaction every
// turn was 403, and the reporter's replays passed with the sentence removed,
// reworded or only half of it. The branch sentence is pi's other fixed
// summary opening and is reworded the same way. Only a text that is pi's
// whole summary, sentence first and </summary> last, changes; the summary
// itself goes on as it is.
const PI_SUMMARIES = [
  ["The conversation history before this point was compacted into the following summary:\n\n<summary>\n", "Earlier conversation context is summarized below:\n\n<summary>\n"],
  ["The following is a summary of a branch that this conversation came back from:\n\n<summary>\n", "Summary of an earlier conversation branch:\n\n<summary>\n"],
]
export function piSummary(text) {
  if (typeof text !== "string" || !text.endsWith("</summary>")) return text
  for (const [from, to] of PI_SUMMARIES) if (text.startsWith(from)) return to + text.slice(from.length)
  return text
}

// promptOpenings adapts clientOpening in the system and developer messages
// of msgs (chat completions' messages, Responses' input), and piSummary in
// their user messages, their string content or text parts: false when
// nothing changed.
function promptOpenings(msgs) {
  let changed = false
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (!m || typeof m !== "object") continue
    const adapt = m.role === "system" || m.role === "developer" ? clientOpening : m.role === "user" ? piSummary : null
    if (!adapt) continue
    if (typeof m.content === "string") {
      if (rewrite(m, "content", adapt)) changed = true
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!p || typeof p !== "object" || typeof p.text !== "string") continue
        if (rewrite(p, "text", adapt)) changed = true
      }
    }
  }
  return changed
}

// droidChat opens msgs' first system message with droid's line, or puts one
// before them with the line alone: false when it opens so already.
function droidChat(msgs) {
  const first = msgs[0]
  if (first && typeof first === "object" && first.role === "system") {
    const c = first.content
    if (typeof c === "string") {
      if (c.startsWith(DROID_LINE)) return false
      first.content = c.trim() === "" ? DROID_LINE : DROID_LINE + "\n" + c
      return true
    }
    if (Array.isArray(c)) {
      // droid sends a string, its blocks joined with "\n": text parts
      // alone are joined so
      let texts = [DROID_LINE]
      for (let i = 0; i < c.length; i++) {
        const p = c[i]
        if (!p || typeof p !== "object" || p.type !== "text" || typeof p.text !== "string") {
          texts = null
          break
        }
        if (i === 0 && p.text.startsWith(DROID_LINE)) return false
        texts.push(p.text)
      }
      first.content = texts ? texts.join("\n") : [{ type: "text", text: DROID_LINE }, ...c]
      return true
    }
  }
  msgs.unshift({ role: "system", content: DROID_LINE })
  return true
}

// droidBody is body, a request to Factory's /api/llm/o at path, as droid
// would open it: Responses' instructions, or chat completions' first system
// message, starting with droid's line. Anything else, a body that can't be
// read, or one that already starts so is returned as it is.
export function droidBody(path, body) {
  if (!path.includes("/llm/o/") || body == null) return body
  const text = bodyText(body)
  if (text === undefined) return body
  let m
  try {
    m = JSON.parse(text)
  } catch {
    return body
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return body
  if (path.endsWith("/responses")) {
    const v = m.instructions
    if (v !== undefined && v !== null && typeof v !== "string") return body // not something droid sends
    const opened = promptOpenings(m.input)
    const ins = clientOpening(v ?? "")
    if (!ins.startsWith(DROID_LINE)) m.instructions = ins.trim() === "" ? DROID_LINE : DROID_LINE + "\n" + ins
    else if (ins !== v || opened) m.instructions = ins
    else return body
  } else if (path.endsWith("/chat/completions")) {
    if (!Array.isArray(m.messages)) return body
    const opened = promptOpenings(m.messages)
    if (!droidChat(m.messages) && !opened) return body
  } else return body
  return JSON.stringify(m)
}