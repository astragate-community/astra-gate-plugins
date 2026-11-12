// The answer as OpenAI's chat completion, from the Run's pieces (the v1 plugin's reply.mjs): chunks of a stream, or one body
// gathered over the reply. The host writes the chunks as SSE and adds `data: [DONE]` itself.

/** The output frames for some of the answer's pieces; st is the reply's state ({ cid, created, model, stream, msg }). */
export function chunksOf(events, st) {
  const out = [];
  const chunk = (delta, finish_reason = null, extra = {}) => ({
    id: st.cid,
    object: 'chat.completion.chunk',
    created: st.created,
    model: st.model,
    choices: [{ index: 0, delta, finish_reason }],
    ...extra,
  });
  for (const e of events) {
    if (e.error) {
      out.push({ $error: e.error });
      return out;
    }
    if (!st.stream) {
      gather(st, e);
      continue;
    }
    if (!st.began) {
      st.began = true;
      out.push(chunk({ role: 'assistant', content: '' }));
    }
    if (e.text) out.push(chunk({ content: e.text }));
    else if (e.reasoning) out.push(chunk({ reasoning_content: e.reasoning }));
    else if (e.tool) out.push(chunk({ tool_calls: [{ index: e.tool.index, id: e.tool.id, type: 'function', function: { name: e.tool.name, arguments: e.tool.args } }] }));
    else if (e.stop) out.push(chunk({}, e.stop, e.usage ? { usage: e.usage } : {}));
  }
  return out;
}

function gather(st, e) {
  const m = (st.msg ??= { content: '', reasoning: '', calls: [], stop: 'stop', usage: null });
  if (e.text) m.content += e.text;
  if (e.reasoning) m.reasoning += e.reasoning;
  if (e.tool) m.calls.push({ id: e.tool.id, type: 'function', function: { name: e.tool.name, arguments: e.tool.args } });
  if (e.stop) [m.stop, m.usage] = [e.stop, e.usage];
}

/** The one body of a non-streaming reply. */
export function bodyOf(st) {
  const m = st.msg ?? { content: '', reasoning: '', calls: [], stop: 'stop', usage: null };
  const message = { role: 'assistant', content: m.content };
  if (m.reasoning) message.reasoning_content = m.reasoning;
  if (m.calls.length) message.tool_calls = m.calls;
  return {
    id: st.cid,
    object: 'chat.completion',
    created: st.created,
    model: st.model,
    choices: [{ index: 0, message, finish_reason: m.stop }],
    ...(m.usage ? { usage: m.usage } : {}),
  };
}
