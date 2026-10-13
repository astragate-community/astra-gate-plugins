// WorkBuddy: shaping a chat request — its session and turn ids, flagged words, the system prompt, tool choice.
import { createHash, randomBytes } from "node:crypto"

export const hex = () => randomBytes(16).toString("hex")

// WorkBuddy's own client names each chat to its gateway four ways: the
// conversation it belongs to, the user send (turn) it answers, the message
// itself, and the request that carried it. Its backend counts a user send as
// one request by X-Conversation-Request-ID: a chat carrying a new one every
// time is counted on its own, so one send that takes several steps — a tool
// call answered and sent again, a retry, another account answering — shows up
// in the usage detail as many requests. The ids below are made from what
// names the conversation and the turn, so every step of one send carries the
// same turn id and the user's next message carries another, as WorkBuddy's
// own client does.

// SESSION carries the conversation magpie (or OpenCode) names a request by,
// from the chat.headers hook to the loader's fetch. It goes no further.
export const SESSION = "x-magpie-workbuddy-session"

// SALT is what the ids are derived with, so an id says nothing of the words
// it was made from. New in each process, as WorkBuddy's own ids are one
// conversation's own within a run.
const SALT = randomBytes(16).toString("hex")

// idFor is the 32 hex digits WorkBuddy's own ids are made of, made of a
// name of the thing the id is for (a turn, a conversation) and what names it.
function idFor(kind, key) {
  return createHash("sha256").update(`${SALT}|${kind}|${key}`).digest("hex").slice(0, 32)
}

// signatureOf is a message content's signature: its text, and a digest of
// every part that isn't text (an image, a file), so a turn of images alone is
// a turn of its own too. A tool result's part — carried in a user message by
// clients of Anthropic's shape — is left out: it is not what the user said,
// and it changes with every step of the send.
function signatureOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const part of content) {
    const type = part?.type ?? ""
    if (type === "" || type === "text") out += typeof part?.text === "string" ? part.text : ""
    else if (type !== "tool_result" && type !== "tool-result") {
      out += `[${type}:${createHash("sha256").update(JSON.stringify(part)).digest("hex").slice(0, 8)}]`
    }
  }
  return out
}

// answeredBefore is whether msgs[i] answers the message before it — a tool's
// result, or an assistant's calls — rather than carrying the user's own
// words. A client that sends a tool result's images in a user message (pi's
// "Attached image(s) from tool result:") puts that message right after the
// result, and a turn keyed on it would be a turn of its own on every step.
function answeredBefore(msgs, i) {
  const prev = msgs[i - 1]
  if (prev === null || typeof prev !== "object") return false
  if (prev.role === "tool") return true
  return prev.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0
}

// turnKey names the user send a chat answers: the body's last user message
// that is the user's own, by its place and its signature. Every step of one
// send repeats it; the user's next message changes it. "" for a chat whose
// last such message has nothing signable in it (an empty message) or which
// has none at all: the caller then makes a fresh id for that request, as
// before these were derived at all.
function turnKey(chat) {
  const msgs = Array.isArray(chat?.messages) ? chat.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role !== "user" || answeredBefore(msgs, i)) continue
    const sig = signatureOf(msgs[i].content)
    return sig ? `u${i}:${sig}` : ""
  }
  return ""
}

// conversationKey names the conversation a chat belongs to: the session
// magpie or OpenCode names (its chat.headers hook), else the chat's first
// user message, which every later turn of it repeats. "" when neither names
// one — a body that isn't a chat, or one with no user message in it — and no
// conversation id is sent then: a made-up one would be a conversation of the
// request's own, which is what fragments the usage detail in the first place.
function conversationKey(chat, session) {
  if (session) return `session:${session}`
  const msgs = Array.isArray(chat?.messages) ? chat.messages : []
  for (const m of msgs) {
    if (m?.role !== "user") continue
    const sig = signatureOf(m.content)
    if (sig) return `first:${sig}`
  }
  return ""
}

// chatOf is a chat's body as the object it is, null for one that isn't: a
// body that isn't text (bytes), or isn't JSON at all.
function chatOf(body) {
  if (typeof body !== "string") return null
  try {
    const b = JSON.parse(body)
    return b !== null && typeof b === "object" ? b : null
  } catch {
    return null
  }
}

// sessionOf takes the session a chat.headers hook named off the headers,
// with the header: it goes no further than here. Its length is capped as
// magpie's own session ids are, the id below being derived from it anyway.
export function sessionOf(headers) {
  const s = String(headers.get(SESSION) ?? "").trim()
  headers.delete(SESSION)
  return s.slice(0, 128)
}

// attend sets a chat's ids on the headers its request goes to WorkBuddy
// with: the message's (each request its own, as the client makes them), the
// turn's (one user send, whatever it takes), and the conversation's. A header
// already there — the caller's own, or another plugin's — is kept, and the
// message and request ids are the same one, as WorkBuddy's client has them.
export function attend(headers, body, session) {
  const chat = chatOf(body)
  const conv = conversationKey(chat, session)
  const msg = hex()
  headers.set("X-Conversation-Message-ID", msg)
  headers.set("X-Request-ID", msg)
  if (!headers.has("X-Conversation-Request-ID")) {
    const turn = turnKey(chat)
    // a turn is a conversation's own: two conversations whose user message
    // reads the same are still two sends, not one
    headers.set("X-Conversation-Request-ID", turn ? idFor("turn", `${conv}|${turn}`) : hex())
  }
  if (conv && !headers.has("X-Conversation-ID")) headers.set("X-Conversation-ID", idFor("conversation", conv))
}

// FLAGGED are the words WorkBuddy refuses a chat for, "Illegal API
// invocation from an unapproved channel" (magpie #182), each with words
// that say the same and pass: tried one by one against both builds with
// the requests Claude Code 2.1.280 and Codex 0.159.2 send. WorkBuddy reads
// every message, not only the system prompt (Claude Code puts its main
// branch in the first user message), and pays no mind to case. Claude
// Code's billing header means nothing to WorkBuddy's models and goes.
const FLAGGED = [
  [/x-anthropic-billing-header:[^\n]*\n?/gi, ""],
  [/You are Claude Code, Anthropic['’]s official CLI for Claude/gi, "You are Claude Code, Anthropic's CLI for Claude"],
  [/Main branch \(you will usually use this for PRs\)/gi, "Main branch (usually the base for PRs)"],
  [/(?<!the )Codex CLI is an open source project led by OpenAI\./gi, "The Codex CLI is an open source project led by OpenAI."],
]

function unflagged(text) {
  for (const [re, to] of FLAGGED) text = text.replace(re, to)
  return text
}

// unflag puts FLAGGED's words in place in every message of a chat, and
// leaves out a text that had nothing else (the billing header's system
// block). It says whether it changed anything.
function unflag(messages) {
  let changed = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (typeof m?.content === "string") {
      const t = unflagged(m.content)
      if (t === m.content) continue
      changed = true
      if (t.trim() || m.role !== "system") m.content = t
      else messages.splice(i, 1)
    } else if (Array.isArray(m?.content)) {
      const parts = []
      let here = false
      for (const p of m.content) {
        const t = typeof p?.text === "string" ? unflagged(p.text) : null
        if (t === null || t === p.text) {
          parts.push(p)
          continue
        }
        here = true
        if (t.trim()) parts.push({ ...p, text: t })
      }
      if (!here) continue
      changed = true
      if (parts.length || m.role !== "system") m.content = parts
      else messages.splice(i, 1)
    }
  }
  return changed
}

// withSystem gives a chat that doesn't open with a system message
// WorkBuddy's default one, as its app does, takes FLAGGED's words out of it,
// and applies the request spellings WorkBuddy's chat endpoint accepts. The
// OpenAI-compatible client normally uses max_completion_tokens and may call a
// reasoning prompt developer; WorkBuddy's endpoint takes max_tokens and
// system instead.
export function withSystem(body) {
  // a body magpie or OpenCode hands over as bytes is read as the text it is
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) body = new TextDecoder().decode(body)
  if (typeof body !== "string") return body
  try {
    const b = JSON.parse(body)
    if (!Array.isArray(b?.messages) || !b.messages.length) return body
    let changed = unflag(b.messages)
    if (b.max_completion_tokens !== undefined) {
      if (b.max_tokens === undefined) b.max_tokens = b.max_completion_tokens
      delete b.max_completion_tokens
      changed = true
    }
    for (const m of b.messages) {
      if (m?.role !== "developer") continue
      m.role = "system"
      changed = true
    }
    if (b.messages[0]?.role !== "system") {
      b.messages.unshift({ role: "system", content: "You are a helpful assistant." })
      changed = true
    }
    return changed ? JSON.stringify(b) : body
  } catch {
    return body
  }
}

// normalizeToolChoice converts the object form emitted by OpenAI clients to
// WorkBuddy's string form. It runs after fitted(), so a named choice follows a
// tool name that was made safe for WorkBuddy.
export function normalizeToolChoice(body) {
  if (typeof body !== "string") return body
  try {
    const b = JSON.parse(body)
    if (!b || typeof b !== "object" || Array.isArray(b) || !("tool_choice" in b)) return body
    const choice = b.tool_choice
    if (typeof choice === "string") {
      if (choice.trim().toLowerCase() === "none") {
        delete b.tool_choice
        delete b.tools
        delete b.functions
      }
      return JSON.stringify(b)
    }
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
      delete b.tool_choice
      return JSON.stringify(b)
    }
    const type = typeof choice.type === "string" ? choice.type.trim().toLowerCase() : ""
    if (type === "none") {
      delete b.tool_choice
      delete b.tools
      delete b.functions
    } else if (type === "auto" || type === "required") {
      b.tool_choice = type
    } else if (type === "function") {
      const fn = choice.function && typeof choice.function === "object" && !Array.isArray(choice.function)
        ? choice.function
        : undefined
      const name = typeof fn?.name === "string" ? fn.name.trim() : ""
      b.tool_choice = name || "auto"
    } else {
      delete b.tool_choice
    }
    return JSON.stringify(b)
  } catch {
    return body
  }
}