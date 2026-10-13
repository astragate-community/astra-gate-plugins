// The Run's first message: the conversation's id, the tools, the model, the blobs.
import { pb, pbValue } from "./protobuf.mjs"
import { GOOS } from "./constants.mjs"
import { tmpdir } from "node:os"
import { createHash, randomUUID } from "node:crypto"

// toolDef is an McpToolDefinition.
export function toolDef(t) {
  const d = pb().str(1, t.name)
  if (t.description) d.str(2, t.description)
  d.bytes(3, pbValue(t.schema))
  return d.str(4, "magpie").str(5, t.name).str(6, t.schemaText).done()
}

export const env = () => pb().str(1, GOOS).str(2, tmpdir()).str(10, "UTC")

// sessionOf is the session a chat.headers hook is told, "" when it names
// none. magpie, with no session header from the agent, makes one of the
// conversation's first user message ("magpie-" and 24 hex digits): that
// names no session, and is taken as none, as the built-in's
// nativeSessionOf takes no such header as none.
export function sessionOf(input) {
  const s = String(input?.sessionID ?? "").trim()
  if (!s || /^magpie-[0-9a-f]{24}$/.test(s)) return ""
  return s.slice(0, 128)
}

// uuidOf is a version 4 UUID made of a hash's first 16 bytes.
function uuidOf(b) {
  b = Buffer.from(b.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// conversationID is the AgentRunRequest's conversation_id for a
// conversation, as the built-in's cursorConversation makes it (magpie
// #498): the same on every request of it, so that Cursor's backend keeps
// sending it to the machine that has its prompt cached — Grok on Cursor
// caches by machine. Cursor's own client keeps one conversationId per
// agent session, so it is made from what names the session — the
// client's prompt_cache_key (Codex's thread id), else the session magpie
// or OpenCode names — together with the conversation's first user
// message, which every later request repeats: subagents running at once
// under one session (Claude Code's Task agents share its session id) are
// separate conversations to Cursor, as they are to its own client. With
// nothing naming the session it is "", and each Run gets a new id as
// before: a first message alone ("hi") would put strangers' conversations
// under one id.
export function conversationID(chat, session) {
  const key = (typeof chat?.prompt_cache_key === "string" ? chat.prompt_cache_key.trim() : "") || session || ""
  if (!key) return ""
  const msgs = Array.isArray(chat?.messages) ? chat.messages : []
  const first = msgs.find((m) => m?.role === "user") ?? msgs[0]
  const sum = createHash("sha256")
    .update("cursor conversation\0" + key + "\0" + (first === undefined ? "" : JSON.stringify(first)))
    .digest()
  return uuidOf(sum)
}

// buildRun is the Run's first message, an AgentClientMessage with its
// run_request, and the blobs it names. The conversation state is the
// messages and one turn, which the server wants there to sample at all.
// conv is the conversation_id (conversationID), a new one when "". The
// model goes as the CLI sends it: in Max Mode when maxMode is set (Cursor
// refuses a model it serves only that way otherwise: "Max Mode
// Required"), with the picker variant's parameters when it has them.
export function buildRun(msgs, lastUser, tools, model, conv = "", { maxMode = false, params = [] } = {}) {
  const blobs = new Map()
  const put = (b) => {
    const id = createHash("sha256").update(b).digest()
    blobs.set(id.toString("hex"), b)
    return id
  }
  const state = pb()
  for (const m of msgs) state.bytes(1, put(m))
  const mid = randomUUID()
  const user = pb().str(1, lastUser).str(2, mid).varint(4, 1).done() // mode: agent
  const turn = pb().bytes(1, pb().bytes(1, put(user)).str(10, mid)).done()
  state.bytes(8, put(turn)).varint(10, 1).str(22, "cli")
  const defs = tools.map(toolDef)
  const rc = pb().bytes(4, env())
  const mcp = pb()
  for (const d of defs) {
    rc.bytes(7, d)
    mcp.bytes(1, d)
  }
  const action = pb().bytes(2, pb().bytes(2, rc)) // resume_action
  // ModelDetails: model_id, display_model_id, display_name, max_mode (7);
  // RequestedModel: model_id, max_mode (2), parameters (3)
  const details = pb().str(1, model).str(3, model).str(4, model)
  const requested = pb().str(1, model)
  if (maxMode) {
    details.varint(7, 1)
    requested.varint(2, 1)
  }
  for (const p of params) requested.bytes(3, pb().str(1, p.id).str(2, p.value))
  const rr = pb()
    .bytes(1, state)
    .bytes(2, action)
    .bytes(3, details)
    .bytes(4, mcp)
    .str(5, conv || randomUUID())
    .bytes(9, requested)
    .varint(19, 1) // inline images
  return { first: pb().bytes(1, rr).done(), blobs }
}
