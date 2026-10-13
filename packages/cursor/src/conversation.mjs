// The chat as Cursor's conversation: AI SDK messages in JSON, with the caller's tools listed.
import { textOf } from "@astragate-community/plugin-kit"
import { CALL, NO_RESULT } from "./constants.mjs"

// Chat clients replay thinking beside content. Cursor's transcript blobs
// use AI SDK reasoning parts; putting it in text would change its role.
const reasoningOf = (m) => [m.reasoning_content, m.reasoning].find((s) => typeof s === "string" && s.trim()) ?? ""

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
      const reasoning_content = [reasoningOf(prev), reasoningOf(m)].filter(Boolean).join("\n\n")
      out[out.length - 1] = { ...prev, content, reasoning_content, tool_calls: [...prev.tool_calls, ...(m.tool_calls ?? [])] }
      continue
    }
    out.push(m)
  }
  return out
}

function parseArgs(s) {
  if (s && typeof s === "object") return s
  try {
    const v = JSON.parse(s || "{}")
    return v && typeof v === "object" ? v : {}
  } catch {
    return {}
  }
}

// tools are the caller's tools the model may call: none for tool_choice
// "none", the one named when one is.
export function toolsOf(chat) {
  const choice = chat.tool_choice
  const only = typeof choice === "object" ? choice?.function?.name : ""
  if (choice === "none") return []
  return (chat.tools ?? [])
    .filter((t) => t?.type === "function" && t.function?.name && (!only || t.function.name === only))
    .map((t) => {
      const schema = t.function.parameters ?? { type: "object", properties: {} }
      return { name: t.function.name, description: t.function.description ?? "", schema, schemaText: JSON.stringify(schema) }
    })
}

// catalog lists the caller's tools for the model. It sees MCP tools only
// through Cursor's GetDynamicTools and CallDynamicTool, and Cursor names
// them in a prompt of its own, which this conversation goes without:
// without the list the model says it has no such tool. Each entry is
// written as the CallDynamicTool call itself: listed as <tool name=...>,
// some models (GLM-5.3) called the names bare, as tools of their own, and
// those calls went nowhere (#11).
export function catalog(tools) {
  if (!tools.length) return ""
  let s = `\n\n<dynamic_tool_catalog>\nThe MCP namespace "magpie" has the tools below. They are reached only through \`${CALL}\`, never as tools of their own. Each entry is the exact call to make; its arguments must match the schema given. The schemas are complete, so there is no need to call \`GetDynamicTools\` first.\n`
  for (const t of tools) s += `<call>${CALL}({"namespace":"magpie","toolName":"${t.name}","arguments":{...}})\n${t.description}\narguments schema: ${t.schemaText}\n</call>\n`
  return s + "</dynamic_tool_catalog>"
}

// callID is a call's id as Cursor gave it, before the line in it was sent
// to the caller as __.
const callID = (id) => (id.startsWith("call_") ? id.replace("__fc_", "\nfc_") : id)

function result(id, text, isError) {
  let res = text
  try {
    res = JSON.parse(text)
  } catch {}
  return {
    type: "tool-result",
    toolCallId: callID(id),
    toolName: CALL,
    result: res,
    experimental_content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  }
}

// messages is the conversation as AI SDK messages, in JSON: the system
// prompt with the caller's tools listed, then each turn. A tool result
// answers a call of the reply before it; a call left unanswered is
// answered for, as the API wants every call to have its result. With it,
// the user's last words and a guess at the prompt's size.
export function conversation(chat, tools) {
  const out = []
  const add = (m) => out.push(Buffer.from(JSON.stringify(m)))
  let size = 0
  const system = []
  let last = "."
  for (const m of chat.messages ?? [])
    if (m.role === "system" || m.role === "developer") system.push(textOf(m.content))
  const sys = system.filter(Boolean).join("\n\n") + catalog(tools)
  size += sys.length
  if (sys) add({ role: "system", content: sys })
  let pending = []
  let results = []
  const answer = () => {
    for (const id of pending) results.push(result(id, NO_RESULT, true))
    pending = []
    if (results.length) add({ role: "tool", content: results })
    results = []
  }
  for (const m of joinSplitCalls(chat.messages ?? [])) {
    if (m.role === "system" || m.role === "developer") continue
    if (m.role === "tool") {
      const id = m.tool_call_id ?? ""
      const i = pending.indexOf(id)
      if (i >= 0) {
        pending.splice(i, 1)
        const text = textOf(m.content)
        size += text.length
        results.push(result(id, text, false))
      }
      continue
    }
    if (m.role === "assistant") {
      answer()
      const content = []
      const reasoning = reasoningOf(m)
      if (reasoning) content.push({ type: "reasoning", text: reasoning })
      const text = textOf(m.content)
      if (text) content.push({ type: "text", text })
      size += reasoning.length + text.length
      for (const c of m.tool_calls ?? []) {
        if (c?.type && c.type !== "function") continue
        const args = parseArgs(c.function?.arguments)
        size += (c.function?.arguments ?? "").length + (c.function?.name ?? "").length
        content.push({ type: "tool-call", toolCallId: callID(c.id), toolName: CALL, args: { namespace: "magpie", toolName: c.function?.name, arguments: args } })
        pending.push(c.id)
      }
      if (content.length) add({ role: "assistant", content })
      continue
    }
    // the user's
    const content = []
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? []
    let first = ""
    for (const p of parts) {
      if (p?.type === "text" && p.text) {
        content.push({ type: "text", text: p.text })
        size += p.text.length
        first ||= p.text
      } else if (p?.type === "image_url") {
        const u = typeof p.image_url === "string" ? p.image_url : p.image_url?.url ?? ""
        const d = /^data:([^;,]+);base64,(.*)$/s.exec(u)
        if (d) content.push({ type: "image", mimeType: d[1], image: { __type: "Uint8Array", hex: Buffer.from(d[2], "base64").toString("hex") } })
        else content.push({ type: "text", text: `[attachment image: ${u}]` })
      } else if (p?.type === "file") {
        content.push({ type: "text", text: `[attachment ${p.file?.filename ?? "file"}]` })
      }
    }
    answer()
    if (first) last = first
    if (content.length) add({ role: "user", content })
  }
  answer()
  for (const t of tools) size += t.name.length + t.description.length + t.schemaText.length
  return { msgs: out, last, estimate: Math.floor(size / 4) }
}
