// Cline's reply (08 §2.2). A streaming reply is plain chat completion SSE and goes through chunk by chunk (an envelope some
// gateways put around a chunk, {"data": …}, is taken off); the refusals Cline's gateway gives are re-mapped in `start`: a ClinePass
// entitlement is a 403, an empty account a 429 "out of credits", a lapsed sign-in a 401 (which asks the plugin's `refresh`).
//
// A caller that did not ask for a stream got one asked for by `prepare` (the reply block frames SSE), and `end` folds the chunks
// into the one chat.completion it wants, taking the {"data": …} envelope off a whole reply the way v1 did.
import { failure } from './refusals.js';

const unwrap = (j) => (j && typeof j === 'object' && !Array.isArray(j.choices) && Array.isArray(j.data?.choices) ? j.data : j);

// folds one chunk of a chat completion into the whole one in `st`
function fold(st, j) {
  if (j.id) st.id ??= j.id;
  if (j.created) st.created ??= j.created;
  if (j.model) st.model ??= j.model;
  if (j.usage) st.usage = j.usage;
  if (j.system_fingerprint) st.fingerprint = j.system_fingerprint;
  for (const c of j.choices ?? []) {
    const ch = (st.choices[c.index ?? 0] ??= { index: c.index ?? 0, message: { role: 'assistant', content: '' }, finish_reason: null });
    const d = c.delta ?? {};
    if (d.content) ch.message.content += d.content;
    for (const k of ['reasoning_content', 'reasoning']) if (typeof d[k] === 'string' && d[k]) ch.message[k] = (ch.message[k] ?? '') + d[k];
    if (typeof d.refusal === 'string' && d.refusal) ch.message.refusal = (ch.message.refusal ?? '') + d.refusal;
    for (const t of d.tool_calls ?? []) {
      const calls = (ch.message.tool_calls ??= []);
      const tc = (calls[t.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (t.id) tc.id = t.id;
      if (t.function?.name) tc.function.name += t.function.name;
      if (t.function?.arguments) tc.function.arguments += t.function.arguments;
    }
    if (c.finish_reason) ch.finish_reason = c.finish_reason;
  }
}

export const transformResponse = {
  start(res, ctx) {
    if (res.status < 200 || res.status > 299) return { error: failure(res.status, (res.body ?? '').slice(0, 1 << 20)) };
    ctx.state.whole = { choices: [] };
  },

  frame(f, ctx) {
    if (f.data === undefined || f.data === '[DONE]') return; // the host closes a chat stream with its own [DONE]
    const j = unwrap(f.json);
    if (j === undefined || j === null) return; // a comment or a keep-alive that isn't JSON
    if (!ctx.request.stream) {
      if (j.error && !j.choices) {
        const code = Number(j.error.code);
        return { $error: { status: code >= 400 && code < 600 ? code : 502, message: String(j.error.message ?? j.error) } };
      }
      fold(ctx.state.whole, j);
      ctx.state.any = true;
      return;
    }
    return j;
  },

  end(ctx) {
    if (ctx.request.stream) return;
    const st = ctx.state.whole;
    if (!ctx.state.any) return { $error: { status: 502, message: 'Cline sent no completion' } };
    return {
      id: st.id,
      object: 'chat.completion',
      created: st.created,
      model: st.model,
      ...(st.fingerprint ? { system_fingerprint: st.fingerprint } : {}),
      choices: st.choices.filter(Boolean),
      ...(st.usage ? { usage: st.usage } : {}),
    };
  },
};
