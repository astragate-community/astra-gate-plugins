// The Go plan's reply (08 §2.2): /alpha/generate answers a JSON object a line (text-delta, reasoning-delta, tool-call, finish …); `frame`
// turns each into chat completion chunks (or, for a caller that did not ask for a stream, folds them into one chat.completion in `end`).
// Like v1, a reply that fails straight away keeps its status (the host reads frames until the first output byte), and one cut short
// after it said something ends with a note and a finish rather than a lost turn.
import { parseArgs, randomHex } from './generate.js';
import { failure, streamError } from './refusals.js';

const FINISH = { 'tool-calls': 'tool_calls', length: 'length', 'content-filter': 'content_filter' };

/** What the notice says when Command Code closed the stream before its finish line (as zen-free does, #91). */
export const CUT_SHORT_NOTE = '(The reply was cut short: Command Code closed the stream before it finished. Ask again to go on.)';

const fail = (status, message) => ({ $error: { status, message } });

// one line of the reply as a piece: text, reasoning, a whole tool call, the finish with the usage, an error; undefined for the rest
function piece(l, st) {
  switch (l.type) {
    case 'text-delta':
      if (!l.text) return;
      st.said = st.wrote = true;
      return { text: l.text };
    case 'reasoning-delta':
      if (!l.text) return;
      st.said = true;
      return { reasoning: l.text };
    case 'tool-call': {
      if (l.providerExecuted) return; // run by the server, its result beside it
      let input = l.input ?? l.args;
      input = typeof input === 'string' ? parseArgs(input) : (input ?? {});
      st.said = true;
      return { tool: { index: st.tools++, id: l.toolCallId || 'call_' + randomHex(12), name: l.toolName, args: JSON.stringify(input) } };
    }
    case 'cache-write-tokens':
      st.cacheWrite = Math.max(st.cacheWrite, l.cacheWriteTokens ?? 0);
      return;
    case 'finish': {
      const t = l.totalUsage ?? {};
      const d = t.inputTokenDetails ?? {};
      let stop = FINISH[l.finishReason] ?? 'stop';
      if (st.tools > 0 && stop === 'stop') stop = 'tool_calls';
      const input = t.inputTokens ?? 0; // the AI SDK's counts the cache in it, as OpenAI's does
      st.finished = true;
      return {
        stop,
        usage: {
          prompt_tokens: input,
          completion_tokens: t.outputTokens ?? 0,
          total_tokens: input + (t.outputTokens ?? 0),
          prompt_tokens_details: { cached_tokens: d.cacheReadTokens ?? 0, cache_write_tokens: Math.max(st.cacheWrite, d.cacheWriteTokens ?? 0) },
          completion_tokens_details: { reasoning_tokens: t.outputTokenDetails?.reasoningTokens ?? 0 },
        },
      };
    }
    case 'abort':
      st.finished = true;
      return { stop: 'stop' };
    case 'error':
      st.finished = true;
      return { error: streamError(l.error) };
  }
}

const head = (ctx) => (ctx.state.head ??= { id: 'chatcmpl-' + randomHex(12), created: Math.floor(Date.now() / 1000), model: ctx.request.model });

function chunk(ctx, delta, finish_reason = null, extra = {}) {
  const h = head(ctx);
  return { id: h.id, object: 'chat.completion.chunk', created: h.created, model: h.model, choices: [{ index: 0, delta, finish_reason }], ...extra };
}

// a piece as chunks (the role chunk goes first, once)
function chunks(ctx, e) {
  const st = ctx.state;
  const out = [];
  if (!st.began) {
    st.began = true;
    out.push(chunk(ctx, { role: 'assistant', content: '' }));
  }
  if (e.text) out.push(chunk(ctx, { content: e.text }));
  else if (e.reasoning) out.push(chunk(ctx, { reasoning_content: e.reasoning }));
  else if (e.tool) out.push(chunk(ctx, { tool_calls: [{ index: e.tool.index, id: e.tool.id, type: 'function', function: { name: e.tool.name, arguments: e.tool.args } }] }));
  else if (e.stop) out.push(chunk(ctx, {}, e.stop, e.usage ? { usage: e.usage } : {}));
  return out;
}

export const transformResponse = {
  start(res, ctx) {
    if (res.status < 200 || res.status > 299) return { error: failure(res.status, (res.body ?? '').slice(0, 1 << 20)) };
    Object.assign(ctx.state, { tools: 0, cacheWrite: 0, said: false, wrote: false, finished: false, began: false, msg: { role: 'assistant', content: '' }, reasoning: '', calls: [], stop: 'stop' });
  },

  frame(f, ctx) {
    const st = ctx.state;
    if (st.finished) return; // nothing follows a finish
    const l = f.json;
    if (!l || typeof l !== 'object') return; // v1 let an unreadable line be
    const e = piece(l, st);
    if (!e) return;
    if (e.error) {
      // before the reply began it keeps its status; after, the stream already said 200: an error block, then the reply ends
      if (!st.began && ctx.request.stream) return fail(e.error.status, e.error.message);
      if (!ctx.request.stream) return fail(e.error.status, e.error.message);
      return { error: { message: e.error.message, code: e.error.status } };
    }
    if (!ctx.request.stream) {
      if (e.text) st.msg.content += e.text;
      if (e.reasoning) st.reasoning += e.reasoning;
      if (e.tool) st.calls.push({ id: e.tool.id, type: 'function', function: { name: e.tool.name, arguments: e.tool.args } });
      if (e.stop) [st.stop, st.usage] = [e.stop, e.usage];
      return;
    }
    return chunks(ctx, e);
  },

  end(ctx) {
    const st = ctx.state;
    if (!ctx.request.stream) {
      if (!st.finished && !st.said) return fail(502, 'the reply ended before it was complete');
      const msg = { ...st.msg };
      if (st.reasoning) msg.reasoning_content = st.reasoning;
      if (st.calls.length) msg.tool_calls = st.calls;
      const h = head(ctx);
      const stop = st.finished ? st.stop : st.tools > 0 ? 'tool_calls' : 'stop';
      return { id: h.id, object: 'chat.completion', created: h.created, model: h.model, choices: [{ index: 0, message: msg, finish_reason: stop }], ...(st.usage ? { usage: st.usage } : {}) };
    }
    if (st.finished) return;
    if (!st.said) return fail(502, 'the reply ended before it was complete');
    // the client has its start: a shorter turn that says so, not a lost one (tool calls come whole, never half written)
    return [chunk(ctx, { content: (st.wrote ? '\n\n' : '') + CUT_SHORT_NOTE }), chunk(ctx, {}, st.tools > 0 ? 'tool_calls' : 'stop')];
  },
};
