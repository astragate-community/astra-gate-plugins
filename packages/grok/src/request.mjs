// Shaping a request for Grok's backend: what its body may hold, the model and window the id names, and the
// headers that go with it.
import { isObj, objectRoot, TOOLS } from "./tools.mjs"
import { sign } from "./identity.mjs"

// bodyText is a request body handed over as bytes read as the text it
// is, so it can be reshaped; any other body is as it came.
export function bodyText(body) {
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
  return body
}

// a Codex collaboration item (agent_message) made of plain text / image parts only, nothing sealed
const isPlainAgentMessage = (it) =>
  isObj(it) && it.type === "agent_message" && !Object.hasOwn(it, "encrypted_content") &&
  Array.isArray(it.content) && it.content.length > 0 &&
  it.content.every((part) => isObj(part) && !Object.hasOwn(part, "encrypted_content") &&
    (part.type === "input_text" && typeof part.text === "string" ||
     part.type === "input_image" && typeof part.image_url === "string"))

// the ordinary message Grok takes in place of one: Codex's collaboration item
// says who it is from and to, which becomes a line of text before its content
function messageOfAgent(it) {
  const from = typeof it.author === "string" ? it.author : ""
  const to = typeof it.recipient === "string" ? it.recipient : ""
  const header = from && to ? `From ${from} to ${to}` : from ? `From ${from}` : to ? `To ${to}` : ""
  return { type: "message", role: "user", content: header
    ? [{ type: "input_text", text: `${header}\n\n` }, ...it.content] : it.content }
}

// rewrite leaves out what Grok's backend doesn't take: tools of other
// types (a freeform apply_patch, a namespace of sub-agent tools), a web
// search's external_web_access, a tool_choice naming a dropped type, and a
// reasoning item's "content": null, beside which it can't read the
// encrypted reasoning. A function's parameters with a union at the root
// (Codex desktop's codex_app automation_update) are folded to an object,
// which Grok turns away otherwise: "tool parameter root must be an object
// type" (magpie#1271).
export function rewrite(body) {
  if (typeof body !== "string" || (!body.includes('"tools"') && !body.includes('"reasoning"') && !body.includes('"agent_message"'))) return body
  let m
  try {
    m = JSON.parse(body)
  } catch {
    return body
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return body
  let dirty = false
  if (Array.isArray(m.tools)) {
    m.tools = m.tools.filter((t) => {
      if (!t || typeof t !== "object") return true
      if (!TOOLS.has(t.type)) {
        dirty = true
        return false
      }
      if ("external_web_access" in t) {
        delete t.external_web_access
        dirty = true
      }
      if (t.type === "function") {
        const fn = isObj(t.function) ? t.function : t
        const ps = objectRoot(fn.parameters)
        if (ps !== fn.parameters) {
          fn.parameters = ps
          dirty = true
        }
      }
      return true
    })
    if (m.tool_choice && typeof m.tool_choice === "object" && !TOOLS.has(m.tool_choice.type)) {
      delete m.tool_choice
      dirty = true
    }
  }
  if (Array.isArray(m.input)) {
    m.input = m.input.map((it) => {
      if (!isPlainAgentMessage(it)) return it
      // Grok takes ordinary messages, not Codex's collaboration item.
      // Sealed tasks remain untouched for the gateway's existing guard.
      dirty = true
      return messageOfAgent(it)
    })
  }
  for (const it of Array.isArray(m.input) ? m.input : []) {
    if (it && it.type === "reasoning" && "content" in it && it.content === null) {
      delete it.content
      dirty = true
    }
  }
  return dirty ? JSON.stringify(m) : body
}

// modelOf splits a requested id into the model Grok lists and the window
// the id names. grok-4.7 is grok-4.7 at its default window (no header);
// grok-4.7@500k is grok-4.7 at 500000 tokens. The header is what the CLI
// sends as x-grok-context-window. The proxy serves up to its largest
// window either way and refuses past it; the header names the window the
// caller asked to compact against. A window no multiple of 1000 is named
// by its digits alone (grok-4.7@131072), as labelOf writes it.
export function modelOf(id) {
  const at = typeof id === "string" ? id.match(/^(.+)@(\d+)(k?)$/) : null
  if (!at || !(Number(at[2]) > 0)) return { model: id, window: 0 }
  return { model: at[1], window: Number(at[2]) * (at[3] ? 1000 : 1) }
}

// outgoing is the headers and body a request goes with: the body reshaped for Grok, the CLI's signature, the
// model and context window its id names, and the conversation its cache key names.
export async function outgoing(req, rawBody, key) {
  let body = rewrite(bodyText(rawBody))
  let parsed = {}
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body) ?? {}
    } catch {}
  }
  const headers = new Headers(req.headers)
  await sign(headers, key)
  const asked = modelOf(parsed.model)
  if (asked.model) {
    headers.set("x-grok-model-override", asked.model)
    if (asked.window && typeof body === "string") {
      parsed.model = asked.model
      body = JSON.stringify(parsed)
    }
  }
  if (asked.window) headers.set("x-grok-context-window", String(asked.window))
  if (typeof parsed.prompt_cache_key === "string" && parsed.prompt_cache_key) headers.set("x-grok-conv-id", parsed.prompt_cache_key)
  headers.delete("content-length")
  return { headers, body }
}
