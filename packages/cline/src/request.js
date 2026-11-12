// Shaping a chat request for Cline's gateway: the task id, the pinned upstream, the headers.
import { crypto } from 'astra';
import { clientHeaders } from './api.js';

const SESSION_HEADERS = ['x-opencode-session', 'x-session-id', 'x-session-affinity'];

/** The conversation's id when the client sent one; '' otherwise (a guess from the first message would not identify a task). */
export function sessionOf(headers = {}) {
  for (const name of SESSION_HEADERS) {
    const s = String(headers[name] ?? '').trim();
    if (s) return s.slice(0, 128);
  }
  return '';
}

/** The task id Cline's gateway groups a chat under: a version-4-shaped UUID derived from the session. */
export function taskIdOf(session) {
  const h = crypto.sha256(`cline task\0${session}`).slice(0, 32);
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const x = `${h.slice(0, 12)}4${h.slice(13, 16)}${variant}${h.slice(17)}`;
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * The upstream a DeepSeek model of Cline's is pinned to when the pinUpstream option is on: Cline's gateway otherwise
 * picks among the providers serving the model, and some answer DeepSeek's models worse than DeepSeek's own API. A
 * cline-free/ model is left to Cline, as is every model that isn't DeepSeek's.
 */
export function pinned(on, model) {
  if (!on || typeof model !== 'string' || model.startsWith('cline-free/')) return '';
  return model
    .slice(model.lastIndexOf('/') + 1)
    .toLowerCase()
    .startsWith('deepseek')
    ? 'deepseek'
    : '';
}

/**
 * The body to send: the client's own, with providerOptions.gateway.only set when pinned (a client's own providerOptions stay).
 * A caller that did not ask for a stream (`stream` false) is asked for one: the manifest's reply block frames the answer as SSE,
 * and reply.js folds the chunks into the one completion the caller wants (the usage chunk is asked for with it).
 */
export function chatBody(body, pin, stream = true) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const up = pinned(pin, body.model);
  let out = up && body.providerOptions === undefined ? { ...body, providerOptions: { gateway: { only: [up] } } } : body;
  if (!stream) out = { ...out, stream: true, stream_options: { ...(out.stream_options ?? {}), include_usage: true } };
  return out;
}

/** The headers to send: the account's token and Cline's identity (the host already took the client's credential off). */
export function chatHeaders(req, bearer) {
  const session = sessionOf(req.headers);
  return { ...clientHeaders(session ? taskIdOf(session) : undefined), Authorization: `Bearer ${bearer}` };
}
