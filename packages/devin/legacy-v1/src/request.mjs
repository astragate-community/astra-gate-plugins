// Shaping a chat completion as GetChatMessage's request.
import { randomUUID } from "node:crypto"
import { textOf } from "@astragate-community/plugin-kit"
import { PB } from "./protobuf.mjs"
import { metadata } from "./api.mjs"
import { inID, objectRoot, toolDescriptions } from "./tools.mjs"

const USER = 1
const ASSISTANT = 2
const TOOL = 4
// answers a call the conversation never answered
const NO_RESULT = "Tool use was interrupted and did not produce a result."

const joinNonEmpty = (...s) => s.filter(Boolean).join("\n\n")

// joinSplitCalls joins an assistant message onto the assistant message
// before it when that one made tool calls: Anthropic takes consecutive
// assistant messages as one turn, and an agent can send a turn's parallel
// calls split over two of them, answered together after (yetone/magpie#1275).
// Answered at the second message, the first calls would be marked
// interrupted and their real results dropped. msgs is left as it is.
export function joinSplitCalls(msgs) {
  const out = []
  for (const m of msgs) {
    const prev = out.at(-1)
    if (m?.role === "assistant" && prev?.role === "assistant" && prev.tool_calls?.length) {
      const content = [textOf(prev.content), textOf(m.content)].filter(Boolean).join("\n\n")
      out[out.length - 1] = { ...prev, content, tool_calls: [...prev.tool_calls, ...(m.tool_calls ?? [])] }
      continue
    }
    out.push(m)
  }
  return out
}

// argsOf is a call's arguments as JSON.
export function argsOf(s) {
  if (s && typeof s === "object") return JSON.stringify(s)
  try {
    const v = JSON.parse(s || "{}")
    return JSON.stringify(v && typeof v === "object" ? v : {})
  } catch {
    return "{}"
  }
}

// a user message's text parts and its data-URL images
function userParts(content) {
  const texts = []
  const images = []
  if (typeof content === "string") {
    if (content) texts.push(content)
  } else
    for (const p of content ?? []) {
      if (p?.type === "text" && p.text) texts.push(p.text)
      else if (p?.type === "image_url") {
        const u = typeof p.image_url === "string" ? p.image_url : p.image_url?.url ?? ""
        const d = /^data:([^,]*),(.*)$/s.exec(u)
        if (d && d[2]) images.push({ data: d[2], type: d[1].replace(/;base64$/, "") || "image/png" })
      }
    }
  return { text: texts.join("\n\n"), images }
}

// conversationOf is the chat's messages as Devin's: the system and developer messages' text apart, the
// rest in turns, each call answered by its result, or by NO_RESULT when the conversation left it open.
export function conversationOf(messages) {
  const msgs = []
  let pending = [] // calls the last reply made, not yet answered
  const answer = () => {
    for (const c of pending) msgs.push({ role: TOOL, callID: c.id, text: NO_RESULT })
    pending = []
  }
  const system = []
  for (const m of joinSplitCalls(messages)) {
    if (m.role === "system" || m.role === "developer") {
      system.push(textOf(m.content))
      continue
    }
    if (m.role === "assistant") {
      const calls = (m.tool_calls ?? []).map((c) => ({ id: inID(c.id), name: c.function?.name, args: argsOf(c.function?.arguments) }))
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((p) => p?.type === "text" && p.text).map((p) => p.text).join("\n\n") : ""
      if (!text && !calls.length) continue // a turn that only thought, or failed
      answer()
      msgs.push({ role: ASSISTANT, text, calls })
      // a copy: answering a call takes it off pending, never off the
      // reply that made it, which goes to Devin with every call it made
      pending = [...calls]
      continue
    }
    if (m.role === "tool") {
      // only a call just made is answered, and only once
      const i = pending.findIndex((c) => c.id === inID(m.tool_call_id))
      if (i >= 0) {
        msgs.push({ role: TOOL, callID: pending[i].id, text: textOf(m.content) || "(no output)" })
        pending.splice(i, 1)
      }
      continue
    }
    if (m.role !== "user") continue
    const { text, images } = userParts(m.content)
    if (!text && !images.length) continue
    answer()
    msgs.push({ role: USER, text, images })
  }
  answer()
  const last = msgs[msgs.length - 1]
  if (!last || (last.role === ASSISTANT && !last.calls.length)) msgs.push({ role: USER, text: "Please proceed with the task." })
  return { msgs, system }
}

// offeredTools is the function tools a chat offers, as { name, description, schema }; none when it says
// tool_choice none.
export function offeredTools(chat) {
  if (chat.tool_choice === "none") return []
  return (chat.tools ?? [])
    .filter((t) => (!t?.type || t.type === "function") && t.function?.name)
    .map((t) => ({ name: t.function.name, description: t.function.description ?? "", schema: objectRoot(t.function.parameters) }))
}

// the instructions go at the head of the first user message: Devin turns
// away some agents' own in its system field. The tools' descriptions go
// there too, each tool sent with only a pointer to its own: Devin
// answers "an internal error occurred" to some agents' tools as they
// describe themselves, and the same words in a message go through
function withInstructions(msgs, instructions) {
  if (!instructions) return
  let at = msgs.findIndex((m) => m.role === USER)
  if (at < 0) {
    msgs.unshift({ role: USER, text: "" })
    at = 0
  }
  msgs[at].text = joinNonEmpty(instructions, msgs[at].text)
}

// the generation settings message (field 8)
function sampling(chat) {
  const max = chat.max_completion_tokens || chat.max_tokens || 128000 // the server holds it to the model's own
  // Devin answers "an internal error occurred" to a temperature or top_p of
  // exactly 0 (on every model: its Claude ones and swe-2), where 1e-6 goes
  // through; a 0 is sent as the smallest step above it, as near greedy
  const above0 = (v) => (v === 0 ? 1e-6 : v)
  const temp = above0(typeof chat.temperature === "number" ? chat.temperature : 1)
  const topP = above0(typeof chat.top_p === "number" ? chat.top_p : 0.95)
  return new PB().varint(1, 1).varint(2, max).varint(3, 400).double(5, temp).varint(7, 40).double(8, topP)
}

function encodeMsg(m) {
  const b = new PB().str(1, randomUUID()).varint(2, m.role)
  if (m.text) b.str(3, m.text)
  for (const c of m.calls ?? []) b.bytes(6, new PB().str(1, c.id ?? "").str(2, c.name ?? "").bytes(3, c.args))
  if (m.callID) b.str(7, m.callID)
  for (const p of m.images ?? []) b.bytes(10, new PB().str(1, p.data).str(2, p.type))
  return b.done()
}

// the caller's tools, and any the conversation used that it no longer
// offers
function encodeTools(out, tools, msgs) {
  const offered = new Set()
  const tool = (name, desc, schema) => {
    if (!schema || typeof schema !== "object") schema = { type: "object", properties: {} }
    offered.add(name)
    out.bytes(10, new PB().str(1, name).str(2, desc || name).bytes(3, JSON.stringify(schema)))
  }
  for (const t of tools) tool(t.name, t.description ? `Described under <tool name="${t.name}"> in <tool_descriptions>, in the instructions.` : "", t.schema)
  for (const m of msgs) for (const c of m.calls ?? []) if (!offered.has(c.name)) tool(c.name, "Tool")
}

// build is the GetChatMessage request for a chat completion, to the model
// uid.
export function build(chat, uid, key) {
  const { msgs, system } = conversationOf(chat.messages ?? [])
  const tools = offeredTools(chat)
  withInstructions(msgs, joinNonEmpty(system.join("\n\n"), toolDescriptions(tools)))
  const out = new PB().bytes(1, metadata(key))
  for (const m of msgs) out.bytes(3, encodeMsg(m))
  out.varint(7, 5)
  out.bytes(8, sampling(chat))
  encodeTools(out, tools, msgs)
  return out.str(21, uid).done()
}
