// The Run's first message: the conversation's id, the tools, the model, the blobs (the v1 plugin's run-request.mjs).
import { crypto, encoding } from 'astra';
import { pb, pbValue } from './protobuf.js';

// The machine the conversation says it runs on. v1 named the host's own OS and temp dir; the sandbox has neither, and none of
// Cursor's tools are run here (they are refused), so a fixed one does.
export const GOOS = 'linux';
const TMP = '/tmp';

/** An McpToolDefinition. */
export function toolDef(t) {
  const d = pb().str(1, t.name);
  if (t.description) d.str(2, t.description);
  d.bytes(3, pbValue(t.schema));
  return d.str(4, 'magpie').str(5, t.name).str(6, t.schemaText).done();
}

export const env = () => pb().str(1, GOOS).str(2, TMP).str(10, 'UTC');

/** A version 4 UUID made of a hash's first 16 bytes. */
function uuidOf(sum) {
  const b = Uint8Array.from(sum.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = encoding.hex.encode(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The session a request names, "" when none: the client's prompt_cache_key (Codex's thread id), else a session header. */
export function sessionOf(chat, headers = {}) {
  const key = typeof chat?.prompt_cache_key === 'string' ? chat.prompt_cache_key.trim() : '';
  const h = String(headers['session_id'] ?? headers['x-session-id'] ?? headers['x-claude-code-session-id'] ?? '').trim();
  return (key || h).slice(0, 128);
}

/**
 * The AgentRunRequest's conversation_id: the same on every request of a conversation, so that Cursor's backend keeps sending it
 * to the machine that has its prompt cached. Made from what names the session together with the conversation's first user
 * message (subagents running at once under one session are separate conversations). With nothing naming the session it is "",
 * and each Run gets a new id: a first message alone ("hi") would put strangers' conversations under one id.
 */
export function conversationID(chat, session) {
  if (!session) return '';
  const msgs = Array.isArray(chat?.messages) ? chat.messages : [];
  const first = msgs.find((m) => m?.role === 'user') ?? msgs[0];
  const sum = crypto.sha256('cursor conversation\0' + session + '\0' + (first === undefined ? '' : JSON.stringify(first)), { encoding: 'bytes' });
  return uuidOf(sum);
}

/**
 * The Run's first message, an AgentClientMessage with its run_request, and the blobs it names (hex sha256 → bytes). The
 * conversation state is the messages and one turn, which the server wants there to sample at all. The model goes as the CLI
 * sends it: in Max Mode when maxMode is set (Cursor refuses a model it serves only that way otherwise), with the picker
 * variant's parameters when it has them.
 */
export function buildRun(msgs, lastUser, tools, model, conv, { maxMode = false, params = [] } = {}) {
  const blobs = new Map();
  const put = (b) => {
    const id = crypto.sha256(b, { encoding: 'bytes' });
    blobs.set(encoding.hex.encode(id), b);
    return id;
  };
  const state = pb();
  for (const m of msgs) state.bytes(1, put(m));
  const mid = crypto.randomUUID();
  const user = pb().str(1, lastUser).str(2, mid).varint(4, 1).done(); // mode: agent
  const turn = pb().bytes(1, pb().bytes(1, put(user)).str(10, mid)).done();
  state.bytes(8, put(turn)).varint(10, 1).str(22, 'cli');
  const defs = tools.map(toolDef);
  const rc = pb().bytes(4, env());
  const mcp = pb();
  for (const d of defs) {
    rc.bytes(7, d);
    mcp.bytes(1, d);
  }
  const action = pb().bytes(2, pb().bytes(2, rc)); // resume_action
  // ModelDetails: model_id, display_model_id, display_name, max_mode (7); RequestedModel: model_id, max_mode (2), parameters (3)
  const details = pb().str(1, model).str(3, model).str(4, model);
  const requested = pb().str(1, model);
  if (maxMode) {
    details.varint(7, 1);
    requested.varint(2, 1);
  }
  for (const p of params) requested.bytes(3, pb().str(1, p.id).str(2, p.value));
  const rr = pb()
    .bytes(1, state)
    .bytes(2, action)
    .bytes(3, details)
    .bytes(4, mcp)
    .str(5, conv || crypto.randomUUID())
    .bytes(9, requested)
    .varint(19, 1); // inline images
  return { first: pb().bytes(1, rr).done(), blobs };
}
