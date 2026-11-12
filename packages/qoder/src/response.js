// Qoder: turning its SSE reply into the chat completion the gateway reads. Qoder's SSE lines are an envelope
// { statusCodeValue, body }, whose body is an OpenAI chunk (as a string) whose content may hold tool calls as XML. The host
// frames the SSE (reply.framing "sse"); each frame is read here, and the host writes what comes back: chunks for a streamed
// request, one chat.completion for a whole one (Qoder always streams, so a whole reply is gathered in the state).
import { failure } from './refusals.js';
import { Splitter } from './toolcalls.js';
import { callId, hexID, tryJSON } from './util.js';

// usageOf is a chunk's usage as OpenAI gives it.
export const usageOf = (u) => ({
  prompt_tokens: u.prompt_tokens ?? 0,
  completion_tokens: u.completion_tokens ?? 0,
  total_tokens: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
  ...(u.prompt_tokens_details?.cached_tokens ? { prompt_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } } : {}),
  ...(u.completion_tokens_details?.reasoning_tokens ? { completion_tokens_details: { reasoning_tokens: u.completion_tokens_details.reasoning_tokens } } : {}),
});

const init = (s) => {
  if (s.splitter) return s;
  Object.assign(s, { splitter: new Splitter(), index: -1, native: -1, usage: undefined, fr: '', done: false, started: false, seen: false, id: 'chatcmpl-' + hexID(), created: Math.floor(Date.now() / 1000),
    msg: { role: 'assistant', content: '' }, reasoning: '', calls: [] });
  return s;
};

// the events one parsed chunk holds: { text } | { reasoning } | { tool } | { args }
function eventsOf(s, chunk) {
  const out = [];
  const delta = chunk?.choices?.[0]?.delta ?? {};
  if (delta.reasoning_content) out.push({ reasoning: delta.reasoning_content });
  if (typeof delta.content === 'string')
    for (const f of s.splitter.feed(delta.content)) {
      if (f.call) out.push({ tool: { index: ++s.index, id: callId(), name: f.call.name, args: f.call.args } });
      else if (f.text) out.push({ text: f.text });
    }
  // tool calls served the OpenAI way keep Qoder's id: a result answers it
  for (const tc of delta.tool_calls ?? []) {
    const i = Number(tc.index ?? 0);
    if (i !== s.native) {
      s.native = i;
      for (const f of s.splitter.flush()) if (f.text) out.push({ text: f.text });
      s.splitter.sawTool = true;
      out.push({ tool: { index: ++s.index, id: tc.id || callId(), name: tc.function?.name ?? '', args: tc.function?.arguments ?? '' } });
    } else if (tc.function?.arguments) out.push({ args: { index: s.index, text: tc.function.arguments } });
  }
  s.fr = chunk?.choices?.[0]?.finish_reason || s.fr;
  // the usage comes in a chunk of its own after the finish, with no choices
  if (chunk?.usage) s.usage = usageOf(chunk.usage);
  return out;
}

const toolCall = (t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } });

// out turns events into output frames (a streamed request) or gathers them (a whole one)
function emit(s, ctx, events) {
  const frames = [];
  const stream = ctx.request.stream !== false;
  const chunk = (delta, finish_reason = null, extra = {}) => ({ id: s.id, object: 'chat.completion.chunk', created: s.created, model: ctx.request.model, choices: [{ index: 0, delta, finish_reason }], ...extra });
  for (const e of events) {
    if (stream) {
      if (!s.started) {
        s.started = true;
        frames.push(chunk({ role: 'assistant', content: '' }));
      }
      if (e.text) frames.push(chunk({ content: e.text }));
      else if (e.reasoning) frames.push(chunk({ reasoning_content: e.reasoning }));
      else if (e.tool) frames.push(chunk({ tool_calls: [{ index: e.tool.index, ...toolCall(e.tool) }] }));
      else if (e.args) frames.push(chunk({ tool_calls: [{ index: e.args.index, function: { arguments: e.args.text } }] }));
      else if (e.stop) frames.push(chunk({}, e.stop, e.usage ? { usage: e.usage } : {}));
    } else if (e.text) s.msg.content += e.text;
    else if (e.reasoning) s.reasoning += e.reasoning;
    else if (e.tool) s.calls.push(toolCall(e.tool));
    else if (e.args) s.calls[s.calls.length - 1].function.arguments += e.args.text;
  }
  return frames;
}

/** start: a refused reply is mapped the way Qoder's codes say; a lapsed sign-in is left to pass so the host's refresh runs. */
export function start(res) {
  if (res.status >= 200 && res.status < 300) return undefined;
  const f = failure(res.status, res.body ?? '');
  if (f.status === 401) return undefined;
  return { error: { status: f.status, message: f.message } };
}

export function frame(f, ctx) {
  const s = init(ctx.state);
  if (s.done) return undefined;
  const env = f.json ?? tryJSON(f.data);
  if (!env || typeof env !== 'object') return undefined;
  const inner = typeof env.body === 'string' ? env.body : '';
  if (env.statusCodeValue != null && env.statusCodeValue !== 200) {
    s.done = true;
    const e = failure(Number(env.statusCodeValue), inner || f.data || '');
    return { $error: { status: e.status, message: e.message } };
  }
  if (inner.trim() === '[DONE]') {
    s.done = true;
    return undefined;
  }
  const chunk = tryJSON(inner);
  if (!chunk) return undefined;
  s.seen = true;
  return emit(s, ctx, eventsOf(s, chunk));
}

export function end(ctx) {
  const s = init(ctx.state);
  const events = [];
  for (const f of s.splitter.flush()) if (f.text) events.push({ text: f.text });
  events.push({ stop: s.splitter.sawTool ? 'tool_calls' : s.fr === 'length' ? 'length' : 'stop', usage: s.usage });
  const frames = emit(s, ctx, events);
  if (ctx.request.stream !== false) return frames;
  const stop = events.at(-1);
  const msg = { ...s.msg };
  if (s.reasoning) msg.reasoning_content = s.reasoning;
  if (s.calls.length) msg.tool_calls = s.calls;
  return { id: s.id, object: 'chat.completion', created: s.created, model: ctx.request.model, choices: [{ index: 0, message: msg, finish_reason: stop.stop }], ...(stop.usage ? { usage: stop.usage } : {}) };
}
