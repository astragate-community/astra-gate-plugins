// Shaping a request for Grok's backend: what its body may hold, the model and window the id names, and the headers that
// go with it. Pure functions: `prepare` in main.js calls them.
import { env } from 'astra';
import { CLIENT_VERSION } from './constants.js';
import { TOOLS, isObj, objectRoot } from './tools.js';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// a Codex collaboration item (agent_message) made of plain text / image parts only, nothing sealed
const isPlainAgentMessage = (it) =>
  isObj(it) && it.type === 'agent_message' && !has(it, 'encrypted_content') &&
  Array.isArray(it.content) && it.content.length > 0 &&
  it.content.every((part) => isObj(part) && !has(part, 'encrypted_content') &&
    ((part.type === 'input_text' && typeof part.text === 'string') || (part.type === 'input_image' && typeof part.image_url === 'string')));

// the ordinary message Grok takes in place of one: Codex's collaboration item says who it is from and to, which becomes
// a line of text before its content
function messageOfAgent(it) {
  const from = typeof it.author === 'string' ? it.author : '';
  const to = typeof it.recipient === 'string' ? it.recipient : '';
  const header = from && to ? `From ${from} to ${to}` : from ? `From ${from}` : to ? `To ${to}` : '';
  return { type: 'message', role: 'user', content: header ? [{ type: 'input_text', text: `${header}\n\n` }, ...it.content] : it.content };
}

/**
 * Leaves out what Grok's backend doesn't take: tools of other types (a freeform apply_patch, a namespace of sub-agent
 * tools), a web search's external_web_access, a tool_choice naming a dropped type, and a reasoning item's
 * "content": null, beside which it can't read the encrypted reasoning. A function's parameters with a union at the root
 * are folded to an object, which Grok turns away otherwise ("tool parameter root must be an object type"). Returns a new
 * body when something changed, else the one it was given; the caller's is never changed.
 */
export function rewrite(body) {
  if (!isObj(body) || (!has(body, 'tools') && !has(body, 'input'))) return body;
  let dirty = false;
  const m = { ...body };
  if (Array.isArray(m.tools)) {
    m.tools = m.tools
      .filter((tool) => {
        if (!tool || typeof tool !== 'object') return true;
        if (!TOOLS.has(tool.type)) {
          dirty = true;
          return false;
        }
        return true;
      })
      .map((tool) => {
        if (!tool || typeof tool !== 'object') return tool;
        let next = tool;
        if ('external_web_access' in next) {
          const { external_web_access: _drop, ...rest } = next;
          next = rest;
          dirty = true;
        }
        if (next.type === 'function') {
          const fn = isObj(next.function) ? next.function : next;
          const ps = objectRoot(fn.parameters);
          if (ps !== fn.parameters) {
            const folded = { ...fn, parameters: ps };
            next = fn === next ? folded : { ...next, function: folded };
            dirty = true;
          }
        }
        return next;
      });
    if (m.tool_choice && typeof m.tool_choice === 'object' && !TOOLS.has(m.tool_choice.type)) {
      delete m.tool_choice;
      dirty = true;
    }
  }
  if (Array.isArray(m.input)) {
    m.input = m.input.map((it) => {
      if (isPlainAgentMessage(it)) {
        // Grok takes ordinary messages, not Codex's collaboration item; sealed ones stay for the gateway's own guard
        dirty = true;
        return messageOfAgent(it);
      }
      if (it && it.type === 'reasoning' && 'content' in it && it.content === null) {
        const { content: _drop, ...rest } = it;
        dirty = true;
        return rest;
      }
      return it;
    });
  }
  return dirty ? m : body;
}

/**
 * Splits a requested id into the model Grok lists and the window the id names. grok-4.7 is grok-4.7 at its default window
 * (no header); grok-4.7@500k is grok-4.7 at 500000 tokens. The proxy serves up to its largest window either way and
 * refuses past it; the header names the window the caller asked to compact against. A window no multiple of 1000 is named
 * by its digits alone (grok-4.7@131072).
 */
export function modelOf(id) {
  const at = typeof id === 'string' ? id.match(/^(.+)@(\d+)(k?)$/) : null;
  if (!at || !(Number(at[2]) > 0)) return { model: id, window: 0 };
  return { model: at[1], window: Number(at[2]) * (at[3] ? 1000 : 1) };
}

const OS = { macos: 'macos', windows: 'windows', linux: 'linux' };

/** The headers that say a request comes from the Grok CLI (the plugin cannot see this machine's CLI version or CPU, so it says its own). */
export function signHeaders(key, version = CLIENT_VERSION) {
  return {
    authorization: `Bearer ${key}`,
    'x-grok-client-version': version,
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-client-identifier': 'grok-shell',
    'x-grok-client-mode': 'headless',
    'user-agent': `grok-shell/${version} (${OS[env.platform] ?? env.platform}; x86_64)`,
  };
}

/** The headers and body a request goes with: the body reshaped for Grok, the CLI's signature, the model and context window its id names, and the conversation its cache key names. */
export function outgoing(body, key) {
  let next = rewrite(body);
  const headers = signHeaders(key);
  const asked = modelOf(next?.model);
  if (asked.model) {
    headers['x-grok-model-override'] = asked.model;
    if (asked.window) next = { ...next, model: asked.model };
  }
  if (asked.window) headers['x-grok-context-window'] = String(asked.window);
  if (typeof next?.prompt_cache_key === 'string' && next.prompt_cache_key) headers['x-grok-conv-id'] = next.prompt_cache_key;
  return { headers, body: next };
}
