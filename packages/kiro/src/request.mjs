// Kiro: the request — Messages → a Kiro conversation, and sending it.
import { randomUUID } from "node:crypto"
import { authHeaders } from "./api.mjs"
import { runtime } from "./constants.mjs"
import { thinks } from "./models.mjs"
import { toolID, toolName } from "./tools.mjs"

const PROCEED = "Please proceed with the task." // Kiro takes no empty message
const NO_RESULT = "Tool use was interrupted and did not produce a result."
const RESULT_LIMIT = 250000 // a tool's output is cut at this, as Kiro's own agent cuts it
const EMPTY_SCHEMA = { type: "object", properties: {} }

// the text of a message's content, its text parts joined by a blank line (the kit's textOf joins with nothing)
const joinedText = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n\n") : ""
const joinNonEmpty = (a, b) => (a && b ? a + "\n\n" + b : a + b)

export function imageFormat(mediaType) {
  const t = String(mediaType ?? "").toLowerCase()
  const f = t.replace(/^image\//, "")
  if (f === "jpg") return "jpeg"
  if (!f || f === t) return "png"
  return f
}

// addImage puts an Anthropic image block in images as Kiro takes it: the
// bytes inline. One named only by a URL has no bytes to send and is left out.
function addImage(images, p) {
  if (p.source?.type === "base64" && p.source.data) images.push({ format: imageFormat(p.source.media_type), source: { bytes: p.source.data } })
}

function documentText(p) {
  const title = p.title ? `${p.title}\n` : ""
  if (p.source?.type === "text") return title + (p.source.data ?? "")
  if (p.source?.type === "content") return title + joinedText(p.source.content)
  return `${title}[a ${p.source?.media_type ?? "document"} attachment]`
}

// thinking is whether the model is asked to think aloud, and for how
// long: when the caller asked for it, of a Claude model (or Auto).
export function thinking(req, model) {
  const effort = req.output_config?.effort ?? ""
  const on = req.thinking?.type === "enabled" || req.thinking?.type === "adaptive" || (effort && effort !== "low")
  if (!on || !thinks(String(model).toLowerCase())) return 0
  const budget = { low: 10000, high: 30000, xhigh: 50000, max: 50000 }[effort]
  if (budget) return budget
  if (!effort && req.thinking?.budget_tokens > 0) return req.thinking.budget_tokens
  return 20000
}

// a user message with nothing in it yet
const emptyUser = (model) => ({ content: "", modelId: model, origin: "KIRO_CLI", images: [] })

// assistantMessage is an assistant turn as Kiro's: its text and its calls; null for a turn that only thought.
function assistantMessage(parts) {
  const texts = []
  const toolUses = []
  for (const p of parts) {
    if (p?.type === "text" && p.text) texts.push(p.text)
    else if (p?.type === "tool_use") {
      const input = p.input && typeof p.input === "object" && !Array.isArray(p.input) ? p.input : {}
      toolUses.push({ name: toolName(p.name), toolUseId: toolID(p.id), input })
    }
  }
  const content = texts.join("\n\n")
  return !content && !toolUses.length ? null : { content, toolUses }
}

// userMessage is a user turn as Kiro's: text, documents as text, images, and tool results.
function userMessage(parts, model) {
  const u = emptyUser(model)
  const texts = []
  const results = []
  for (const p of parts) {
    if (p?.type === "text") {
      if (p.text) texts.push(p.text)
    } else if (p?.type === "document") texts.push(documentText(p))
    else if (p?.type === "image") addImage(u.images, p)
    else if (p?.type === "tool_result") {
      let out = joinedText(p.content)
      if (out.length > RESULT_LIMIT) out = out.slice(0, RESULT_LIMIT) + "\n… (cut)"
      results.push({ toolUseId: toolID(p.tool_use_id), status: p.is_error ? "error" : "success", content: [{ text: out || "(no output)" }] })
      // a tool's images (a screenshot, Codex's view_image) go with the
      // message, as Kiro's tool results carry text alone (magpie #369, #1861)
      if (Array.isArray(p.content)) for (const c of p.content) if (c?.type === "image") addImage(u.images, c)
    }
  }
  u.content = texts.join("\n\n")
  if (results.length) u.userInputMessageContext = { toolResults: results }
  return u
}

// entriesOf is the conversation's turns, each of one side, consecutive turns of a side merged.
function entriesOf(messages, model) {
  const entries = []
  for (const m of messages) {
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? []
    if (m.role === "assistant") {
      const a = assistantMessage(parts)
      if (!a) continue
      const prev = entries.at(-1)?.assistantResponseMessage
      if (prev) {
        prev.content = joinNonEmpty(prev.content, a.content)
        prev.toolUses.push(...a.toolUses)
      } else entries.push({ assistantResponseMessage: a })
      continue
    }
    const u = userMessage(parts, model)
    const prev = entries.at(-1)?.userInputMessage
    if (prev) {
      prev.content = joinNonEmpty(prev.content, u.content)
      prev.images.push(...u.images)
      if (u.userInputMessageContext) (prev.userInputMessageContext ??= { toolResults: [] }).toolResults.push(...u.userInputMessageContext.toolResults)
    } else entries.push({ userInputMessage: u })
  }
  return entries
}

// the conversation opens with something the user said: tool results with
// no call before them go, and a reply the caller began with
function openWithUser(entries) {
  while (entries.length) {
    const u = entries[0].userInputMessage
    if (u) {
      if (u.userInputMessageContext && !u.content && !u.images.length) {
        entries.shift()
        continue
      }
      delete u.userInputMessageContext
      break
    }
    entries.shift()
  }
}

// each call is answered in the message after it, and only calls are
function pairToolResults(entries) {
  entries.forEach((e, i) => {
    const u = e.userInputMessage
    if (!u) return
    const calls = entries[i - 1]?.assistantResponseMessage?.toolUses ?? []
    const results = u.userInputMessageContext?.toolResults ?? []
    const answered = new Set()
    const kept = []
    for (const r of results)
      if (!answered.has(r.toolUseId) && calls.some((c) => c.toolUseId === r.toolUseId)) {
        answered.add(r.toolUseId)
        kept.push(r)
      }
    for (const c of calls)
      if (!answered.has(c.toolUseId)) {
        answered.add(c.toolUseId)
        kept.push({ toolUseId: c.toolUseId, status: "error", content: [{ text: NO_RESULT }] })
      }
    delete u.userInputMessageContext
    if (kept.length) u.userInputMessageContext = { toolResults: kept }
    if (!u.content && !u.userInputMessageContext) u.content = PROCEED
  })
}

// only the latest images are sent again, as Kiro's own agent does
function keepLatestImages(entries) {
  let latest = -1
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i].userInputMessage?.images.length) {
      latest = i
      break
    }
  entries.forEach((e, i) => {
    const u = e.userInputMessage
    if (u && (i !== latest || !u.images.length)) delete u.images
  })
}

// toolSpecs are the caller's tools, and any the conversation used that it no longer
// offers — Kiro rejects a history naming a tool it wasn't given
function toolSpecs(callerTools, entries) {
  const tools = []
  const offered = new Set()
  for (const t of callerTools ?? []) {
    if (!t?.name || (t.type && t.type !== "custom" && !t.input_schema)) continue // server tools Kiro hasn't
    const name = toolName(t.name)
    offered.add(name)
    tools.push({ toolSpecification: { name, description: t.description || t.name, inputSchema: { json: t.input_schema ?? EMPTY_SCHEMA } } })
  }
  for (const e of entries)
    for (const c of e.assistantResponseMessage?.toolUses ?? [])
      if (!offered.has(c.name)) {
        offered.add(c.name)
        tools.push({ toolSpecification: { name: c.name, description: "Tool", inputSchema: { json: EMPTY_SCHEMA } } })
      }
  return tools
}

// buildKiro is the body of a generateAssistantResponse call.
export function buildKiro(req, model, profile, budget) {
  const entries = entriesOf(req.messages ?? [], model)
  openWithUser(entries)
  // and ends with it, the message being answered
  if (!entries.at(-1)?.userInputMessage) entries.push({ userInputMessage: emptyUser(model) })
  pairToolResults(entries)
  keepLatestImages(entries)
  for (const e of entries) if (e.assistantResponseMessage && !e.assistantResponseMessage.toolUses.length) delete e.assistantResponseMessage.toolUses
  // the instructions go at the head of the first message
  let system = joinedText(req.system)
  if (budget) system = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>` + (system ? "\n" + system : "")
  if (system) entries[0].userInputMessage.content = system + "\n\n" + entries[0].userInputMessage.content

  const current = entries.at(-1).userInputMessage
  const tools = toolSpecs(req.tools, entries)
  if (tools.length) (current.userInputMessageContext ??= {}).tools = tools

  const state = { chatTriggerType: "MANUAL", agentTaskType: "vibe", conversationId: randomUUID(), currentMessage: { userInputMessage: current } }
  if (entries.length > 1) state.history = entries.slice(0, -1)
  const out = { conversationState: state, agentMode: "vibe" }
  if (profile) out.profileArn = profile
  return JSON.stringify(out)
}

export function sendKiro(a, body, signal) {
  const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${randomUUID().replaceAll("-", "")}`
  return fetch(runtime(a.region) + "/generateAssistantResponse", {
    method: "POST",
    headers: {
      ...authHeaders(a),
      "Content-Type": "application/json",
      Accept: "application/vnd.amazon.eventstream",
      "x-amzn-codewhisperer-optout": "true",
      "amz-sdk-invocation-id": randomUUID(),
      "amz-sdk-request": "attempt=1; max=1",
      "x-amzn-kiro-agent-mode": "vibe",
      "x-amz-user-agent": ua,
      "User-Agent": ua,
    },
    body,
    signal,
  })
}
