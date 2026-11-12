// Grok's reply (manifest `reply: { framing: ndjson, output: responses }`). The plugin has one job here, as in v1: note
// what each reply says of the account's rate limit (ratelimit.js, shown on the usage card). The events themselves go on as
// they came.
//
// Why ndjson: an `sse` reader would swallow a plain JSON body (a non-streaming request) as a stream with no events, so the
// plugin takes the lines (`{ text }` for `event:` / `data:`, `{ json }` for a one-line body) and puts the Responses events
// back together itself. A `data:` event spanning several lines would not survive; the Responses API writes none.
import { note } from './ratelimit.js';

export const transformResponse = {
  start(res, ctx) {
    note(ctx.account?.key, res.status, res.headers);
    ctx.state.buf = '';
    ctx.state.event = undefined;
  },

  frame(f, ctx) {
    const s = ctx.state;
    if (f.json !== undefined) {
      // a whole one-line JSON body
      if (!ctx.request.stream) return void (s.body = f.json);
      return f.json?.error ? { event: 'error', data: { type: 'error', ...f.json } } : { $error: { status: 502, message: 'Grok answered a streaming request with a plain body' } };
    }
    const line = String(f.text ?? '');
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) {
      s.event = line.slice(6).trim();
      return;
    }
    if (!line.startsWith('data:')) {
      s.buf += line + '\n'; // a pretty-printed JSON body
      return;
    }
    const raw = line.slice(5).replace(/^ /, '');
    const event = s.event;
    s.event = undefined;
    if (raw.trim() === '[DONE]') return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { $error: { status: 502, message: "Invalid JSON in Grok's event stream" } };
    }
    if (!ctx.request.stream) return;
    return { event: event ?? data?.type ?? 'message', data };
  },

  end(ctx) {
    const s = ctx.state;
    if (s.body === undefined && s.buf.trim()) {
      try {
        s.body = JSON.parse(s.buf);
      } catch {}
    }
    if (ctx.request.stream) {
      if (s.buf.trim() && s.body !== undefined) return { event: 'error', data: { type: 'error', ...(s.body?.error ? s.body : { error: { message: 'Grok answered a streaming request with a plain body' } }) } };
      return;
    }
    if (s.body === undefined) return { $error: { status: 502, message: 'Grok answered with no body' } };
    return s.body;
  },
};
