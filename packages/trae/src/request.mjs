// Trae: shaping the chat request — the conversation as Trae's chat takes it, the llm_utils_chat body, and the
// session id a conversation is counted by.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { CLOSE, OPEN, SESSION } from "./constants.mjs"
import { nativeTools, toolPrompt } from "./tools.mjs"

export const partText = (content) => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : String(content)
  return content
    .map((p) => (typeof p === "string" ? p : p?.type === "text" || p?.type === "input_text" ? p.text ?? "" : p?.type === "image_url" ? "[an image, which this model can't see]" : ""))
    .filter(Boolean)
    .join("\n")
}

// traeMessages is the conversation as Trae's chat takes it
export function traeMessages(req) {
  const tools = Array.isArray(req.tools) && req.tools.length && req.tool_choice !== "none" ? req.tools : []
  const names = new Map()
  const out = []
  if (tools.length) out.push({ role: "system", text: toolPrompt(tools, req.tool_choice, req.parallel_tool_calls) })
  for (const m of req.messages ?? []) {
    const role = m.role === "developer" ? "system" : m.role
    let text = partText(m.content)
    if (role === "assistant") {
      const calls = (m.tool_calls ?? []).map((c) => {
        names.set(c.id, c.function?.name)
        let args = c.function?.arguments ?? "{}"
        try {
          args = JSON.parse(args)
        } catch {}
        return OPEN + JSON.stringify({ name: c.function?.name, arguments: args }) + CLOSE
      })
      text = [text, ...calls].filter(Boolean).join("\n")
      out.push({ role: "assistant", text })
    } else if (role === "tool") {
      out.push({ role: "user", text: `Result of ${names.get(m.tool_call_id) || m.name || "the tool"} (call ${m.tool_call_id ?? "?"}):\n${text}` })
    } else {
      out.push({ role: role === "system" ? "system" : "user", text })
    }
  }
  // Trae takes no empty message, nor two of one role in a row
  const merged = []
  for (const m of out) {
    if (!m.text) continue
    const last = merged.at(-1)
    if (last && last.role === m.role && m.role !== "system") last.text += "\n\n" + m.text
    else merged.push({ ...m })
  }
  return merged.map((m) => ({ role: m.role, content: [{ type: "text", text: m.text }] }))
}

// SALT is what the id is derived with, so it says nothing of the words it was
// made from. New in each process, as Trae's own session ids are one session's
// own within a run.
const SALT = randomBytes(16).toString("hex")

// conversationID is the conversation a chat belongs to, as the UUID the
// request's session_id wants: the session magpie or OpenCode names (its
// chat.headers hook), else the chat's first user message, which every later
// turn of the conversation repeats. "" when neither names one — a body that
// isn't a chat, or one with no user message in it — and the caller then makes
// a fresh id per request, as before: a made-up conversation of the request's
// own is the very splitting this is here to end.
//
// who is the account the request is made as (its uid, else its name), and it
// is part of what the id is made of, so one conversation answered by two
// accounts (magpie failing over, or rotating, inside it) is two conversations
// as Trae is concerned — an id a fresh random one never linked, and one that
// would let Trae read one conversation as another's. The cost is that such a
// conversation's two halves are counted apart again, which is what it did
// before this named one at all.
export function conversationID(chat, session, who = "") {
  const account = String(who ?? "").trim()
  if (session) return uuidOf("magpie-trae-session|" + account + "|" + session)
  const first = (Array.isArray(chat?.messages) ? chat.messages : []).find((m) => m?.role === "user")
  const text = partText(first?.content ?? "")
  return text.trim() ? uuidOf("magpie-trae-first|" + account + "|" + text) : ""
}

// uuidOf is a version 4 UUID made of a hash's first 16 bytes: the shape
// randomUUID() returns, since that is what session_id carried before.
export function uuidOf(s) {
  const b = Buffer.from(createHash("sha256").update(SALT + "|" + s).digest().subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// sessionOf takes the session a chat.headers hook named off the headers, with
// the header: it goes no further than here. Its length is capped as magpie's
// own session ids are, the id being derived from it anyway.
export function sessionOf(headers) {
  const s = String(headers.get(SESSION) ?? "").trim()
  headers.delete(SESSION)
  return s.slice(0, 128)
}

// chatBody is the request for llm_utils_chat; modelName is the model the
// function's list names for the config (its __dev one), when it named one,
// and most the max_tokens it gives that model (0: none given), which a
// request asking more is held to. A Max model (max: {base, window}) asks
// the config base by its __max model, max_tokens always set, and gives
// the prompt the room the window has beside it, as the IDE's Max mode does.
//
// session is the conversation's id, made by conversationID, so every request
// of one conversation carries one: Trae counts a conversation by the session
// the requests name, and a request naming a new session each time is counted
// as a conversation of its own — one user send that takes several steps (a
// tool result sent back, a retry, another function answering) shows up in the
// usage detail as several, each under no title at all. request_id stays a
// fresh id per request, being that request's own.
export function chatBody(req, fn, modelName, most = 0, max = null, session = "") {
  const config = max?.base ?? req.model
  const body = {
    messages: traeMessages(req),
    function: fn,
    config_name: config,
    model: config,
    ...(modelName ? { model_name: modelName } : {}),
    stream: true, // Trae answers in SSE either way
    request_id: randomUUID(),
    session_id: session || randomUUID(),
  }
  const asked = req.max_completion_tokens ?? req.max_tokens
  if (Number.isFinite(asked) && asked > 0) body.max_tokens = most > 0 ? Math.min(Math.floor(asked), most) : Math.floor(asked)
  if (max?.window) {
    if (!body.max_tokens && most > 0) body.max_tokens = most
    body.user_message_context = { model_info: { prompt_max_tokens: max.window - (body.max_tokens || 0) } }
  }
  if (typeof req.temperature === "number") body.temperature = req.temperature
  if (Array.isArray(req.tools) && req.tools.length && req.tool_choice !== "none") {
    body.tools = nativeTools(req.tools)
    const c = req.tool_choice
    if (c && typeof c === "object") body.tool_choice = c.function?.name || c.name || "auto"
    else if (typeof c === "string") body.tool_choice = c
    if (typeof req.parallel_tool_calls === "boolean") body.parallel_tool_calls = req.parallel_tool_calls
  }
  return body
}
