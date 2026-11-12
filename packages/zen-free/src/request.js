// Shaping a request for Zen: keeping the agent's tools, and the headers (OpenCode's client identity, one session id
// everywhere) the request goes out with. Pure functions: `prepare` in main.js calls them.
import { crypto } from 'astra';
import { BASE, CORE_TOOLS, OPENCODE_VERSION, PATHS, PUBLIC_KEY } from './constants.js';

/** The tool names the agent itself declared (what a reply may call), before any stub is added. */
export function declaredTools(body, protocol) {
  const names = new Set();
  if (!body || typeof body !== 'object') return names;
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const name = protocol === 'chat' ? tool?.function?.name : tool?.name;
    if (typeof name === 'string') names.add(name);
  }
  if (protocol === 'chat' && Array.isArray(body.functions)) for (const tool of body.functions) if (typeof tool?.name === 'string') names.add(tool.name);
  return names;
}

/**
 * Adds the core tools the agent did not declare, as stubs that say they are unavailable (Zen's models expect
 * OpenCode's tool set). Zen is always asked to stream (the reply transform collapses it again for a client that wanted one body). Returns a new
 * body; the host's own is left alone.
 */
export function withCoreTools(body, protocol) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const next = { ...body, stream: true, tools: Array.isArray(body.tools) ? [...body.tools] : [] };
  const present = new Set(next.tools.map((tool) => (protocol === 'chat' ? tool?.function?.name : tool?.name)));
  for (const name of CORE_TOOLS) {
    if (present.has(name)) continue;
    const parameters = { type: 'object', properties: {}, additionalProperties: false };
    const definition = { name, description: 'Not available. Never call this tool.' };
    next.tools.push(
      protocol === 'chat'
        ? { type: 'function', function: { ...definition, parameters } }
        : protocol === 'anthropic'
          ? { ...definition, input_schema: parameters }
          : { type: 'function', ...definition, parameters },
    );
  }
  if (protocol === 'chat') next.stream_options = { ...next.stream_options, include_usage: true };
  return next;
}

const SESSION_HEADERS = ['x-opencode-session', 'x-session-affinity', 'x-session-id', 'conversation-id'];
const SESSION_FORMAT = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The conversation's id in OpenCode's `ses_…` format, from a header, the body's metadata or its first user turn. */
export function sessionID(headers, body) {
  let signal;
  for (const name of SESSION_HEADERS) {
    if (headers[name]) {
      signal = headers[name];
      break;
    }
  }
  if (!signal && typeof body?.metadata?.session_id === 'string') signal = body.metadata.session_id;
  if (!signal) {
    const messages = body?.messages ?? body?.input;
    const first = Array.isArray(messages) ? messages.find((message) => message.role === 'user')?.content : messages;
    signal = first ? JSON.stringify(first) : crypto.randomUUID();
  }
  if (SESSION_FORMAT.test(signal)) return signal;
  // Keep conversation affinity using OpenCode's canonical session format.
  const hash = crypto.sha256(`ses\0${signal}`);
  let value = BigInt(`0x${hash.slice(12, 32)}`);
  let suffix = '';
  for (let i = 0; i < 14; i++) {
    suffix = BASE62[Number(value % 62n)] + suffix;
    value /= 62n;
  }
  return `ses_${hash.slice(0, 12)}${suffix}`;
}

/** The headers a request goes to Zen with: OpenCode's identity, the session id, the public credential. */
export function upstreamHeaders(req, project = 'global') {
  const session = sessionID(req.headers ?? {}, req.body);
  const headers = {
    'user-agent': `opencode/${OPENCODE_VERSION}`,
    'x-opencode-client': 'cli',
    'x-opencode-request': `req_${crypto.randomUUID().replaceAll('-', '')}`,
    'x-opencode-project': req.headers?.['x-opencode-project'] ?? project,
    'x-opencode-session': session,
    'x-session-affinity': session,
    'x-session-id': session,
  };
  if (req.protocol === 'anthropic') {
    headers['x-api-key'] = PUBLIC_KEY;
    if (!req.headers?.['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${PUBLIC_KEY}`;
  }
  return headers;
}

/** Where a request goes: Zen's endpoint for its protocol, or null for one Zen has none for (gemini). */
export function upstreamUrl(protocol) {
  return PATHS[protocol] ? `${BASE}${PATHS[protocol]}` : null;
}
