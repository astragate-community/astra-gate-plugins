// Trae: its reply as an OpenAI chat reply. The provider's manifest entry says `reply: { framing: 'sse', output: 'chat' }`,
// the host cuts Trae's SSE into frames, and transformResponse turns each into chat chunks (a stream) or gathers them
// into the one body a non-streaming request wants.
import { crypto, encoding } from 'astra';
import { errorOf, failure, wrongFunction } from './errors.js';
import { Answer } from './parts.js';

// What the request's tools were, by account and model: transformResponse sees only the reply, not the request, and the
// request's tool names decide how a call's name is written (Read for read). The latest request's list is the one used.
const toolsOf = new Map();
export const rememberTools = (key, model, tools) => {
  toolsOf.set(key + '|' + model, tools);
  if (toolsOf.size > 200) toolsOf.delete(toolsOf.keys().next().value);
};

// the chat functions Trae refused for a model ("a model this function doesn't take"), per account: the next request of
// that model asks another (what v1 did inside one request, the host's retry does here)
const refused = new Set();
export const refusedBy = (key, model, fn) => refused.has(`${key}|${model}|${fn}`);
export const lastFn = new Map();
const refuse = (key, model) => {
  const fn = lastFn.get(key + '|' + model);
  if (fn) refused.add(`${key}|${model}|${fn}`);
  if (refused.size > 500) refused.delete(refused.values().next().value);
};
export const forgetRefusals = (key, model) => {
  for (const r of [...refused]) if (r.startsWith(`${key}|${model}|`)) refused.delete(r);
};

const hex = (n) => encoding.hex.encode(crypto.randomBytes(n));

function init(site, ctx) {
  const s = ctx.state;
  if (s.id) return s;
  const key = ctx.account?.key ?? '';
  s.key = key;
  s.model = ctx.request.model;
  s.stream = ctx.request.stream !== false;
  s.id = 'chatcmpl-' + hex(12);
  s.created = Math.floor(Date.now() / 1000);
  s.answer = new Answer(toolsOf.get(key + '|' + s.model) ?? [], site.realm);
  s.frames = 0;
  s.text = '';
  s.reasoning = '';
  s.calls = [];
  s.usage = null;
  s.finish = '';
  s.began = false; // the role chunk is out
  return s;
}

const chunk = (s, delta, finish = null, extra = {}) => ({ id: s.id, object: 'chat.completion.chunk', created: s.created, model: s.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });

// the output of some parts: chunks for a stream, gathered into the state for a body. An error part is the reply's failure.
function emit(site, s, parts) {
  const out = [];
  const begin = () => {
    if (s.stream && !s.began) {
      s.began = true;
      out.push(chunk(s, { role: 'assistant', content: '' }));
    }
  };
  for (const p of parts) {
    if (p.error) {
      if (wrongFunction(p.code)) refuse(s.key, s.model);
      const f = failure(site, 502, p.code, p.error);
      return { $error: { status: f.status, message: f.message } };
    }
    if (p.text) {
      if (s.stream) (begin(), out.push(chunk(s, { content: p.text })));
      else s.text += p.text;
    }
    if (p.reasoning) {
      if (s.stream) (begin(), out.push(chunk(s, { reasoning_content: p.reasoning })));
      else s.reasoning += p.reasoning;
    }
    if (p.call) {
      if (s.stream) (begin(), out.push(chunk(s, { tool_calls: [{ index: s.calls.length, id: p.call.id, type: 'function', function: { name: p.call.name, arguments: p.call.arguments } }] })));
      s.calls.push(p.call);
    }
    if (p.usage) s.usage = p.usage;
    if (p.finish) s.finish = p.finish;
  }
  return out;
}

const eventOf = (f) => {
  const data = f.json !== undefined ? f.json : f.data;
  return { data, event: f.event || (data && typeof data === 'object' ? String(data.event ?? data.type ?? '') : '') };
};

export const transformResponse = (site) => ({
  start(res, ctx) {
    init(site, ctx);
    if (res.status >= 400) {
      const e = errorOf(res.body ?? '');
      if (res.status === 400 && wrongFunction(e.code)) refuse(ctx.state.key, ctx.state.model);
      const f = failure(site, res.status, e.code, e.message || String(res.body ?? '').trim().slice(0, 300));
      return { error: { status: f.status, message: f.message } };
    }
  },
  frame(f, ctx) {
    const s = init(site, ctx);
    s.frames++;
    const { event, data } = eventOf(f);
    return emit(site, s, s.answer.push(event, data));
  },
  end(ctx) {
    const s = init(site, ctx);
    // a 200 that held no event at all (Trae answers an error as JSON in a 200 now and then): not an empty answer
    if (!s.frames) return { $error: { status: 502, message: `${site.realm}: Trae sent no answer` } };
    const out = emit(site, s, s.answer.end());
    if (!Array.isArray(out)) return out;
    if (s.stream) {
      if (!s.began) (s.began = true, out.push(chunk(s, { role: 'assistant', content: '' })));
      out.push(chunk(s, {}, s.calls.length ? 'tool_calls' : s.finish || 'stop'));
      if (s.usage) out.push({ id: s.id, object: 'chat.completion.chunk', created: s.created, model: s.model, choices: [], usage: s.usage });
      return out;
    }
    const message = { role: 'assistant', content: s.text || (s.calls.length ? null : '') };
    if (s.reasoning) message.reasoning_content = s.reasoning;
    if (s.calls.length) message.tool_calls = s.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
    const body = { id: s.id, object: 'chat.completion', created: s.created, model: s.model, choices: [{ index: 0, message, finish_reason: s.calls.length ? 'tool_calls' : s.finish || 'stop' }] };
    if (s.usage) body.usage = s.usage;
    return body;
  },
});
