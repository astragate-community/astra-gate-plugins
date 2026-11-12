// What a "-Trial" (gift) entry's reply says. The gift answers a spent bucket with a quota error (code 1113 "Insufficient
// balance or no resource package", 1005 "exceed quota limit"), which it can put inside an HTTP 200 JSON body; that becomes
// a 429 (so another account or the coding plan's own entry can take over) and keeps the model off the gift for a minute.
// Any other gift answer goes on as it came: the user picked the gift, so the coding plan is not spent behind their back.
// Only trial requests are looked at; every other reply is passed on as it is.
//
// The manifest declares framing `ndjson`, not `sse`: a plain JSON 200 body has to reach `frame` (an `sse` reader would
// swallow it as a stream without events), and ZCode's Anthropic stream is one-line `event:` / `data:` pairs, which come as
// `{ text }` lines and are put back together here. A streamed body is never buffered.
import { block, spentUp } from './gift.js';
import { stateOf } from './session.js';

export const isTrial = (model) => String(model ?? '').toLowerCase().endsWith('-trial');

const wordsOf = (body, fallback) => {
  let msg = String(body ?? '').trim();
  try {
    const v = JSON.parse(body);
    msg = v?.msg ?? v?.message ?? v?.error?.message ?? msg;
  } catch {}
  return msg || fallback;
};

async function blockFor(ctx) {
  const account = ctx.account;
  if (!account) return;
  const s = stateOf(await account.secret());
  if (s) block(account.key, s, String(ctx.request.model).replace(/-trial$/i, ''));
}

export const transformResponse = {
  async start(res, ctx) {
    const s = ctx.state;
    s.trial = isTrial(ctx.request.model);
    s.buf = '';
    s.event = undefined;
    if (!s.trial || res.status < 400) return;
    if (!spentUp(res.body ?? '', res.status)) return;
    await blockFor(ctx);
    // a 429 is already one; anything else that says "spent" is made one
    if (res.status !== 429) return { error: { status: 429, message: wordsOf(res.body, "ZCode's limited quota is exhausted") } };
  },

  async frame(f, ctx) {
    const s = ctx.state;
    let data;
    if (f.json !== undefined) {
      // a whole JSON body (not an event line)
      if (s.trial && spentUp(f.json, 200)) {
        await blockFor(ctx);
        return { $error: { status: 429, message: wordsOf(JSON.stringify(f.json), "ZCode's limited quota is exhausted") } };
      }
      data = f.json;
      if (!ctx.request.stream) return void (s.body = data);
      return { event: 'error', data: data?.type === 'error' ? data : { type: 'error', error: { type: 'api_error', message: wordsOf(JSON.stringify(data), 'unexpected reply') } } };
    }
    const line = String(f.text ?? '');
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) {
      s.event = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) {
      const raw = line.slice(5).replace(/^ /, '');
      const event = s.event;
      s.event = undefined;
      try {
        data = JSON.parse(raw);
      } catch {
        return; // [DONE] or a keep-alive
      }
      if (!data || typeof data !== 'object') return;
      if (ctx.request.stream) return { event: event ?? data.type ?? 'message', data };
      // a one-body reply over a stream: not what was asked for, so take the final message the events carry
      if (data.type === 'message') s.body = data;
      return;
    }
    // part of a pretty-printed JSON body
    s.buf += line + '\n';
  },

  async end(ctx) {
    const s = ctx.state;
    // a pretty-printed JSON body arrived as lines
    if (s.body === undefined && s.buf.trim()) {
      let body;
      try {
        body = JSON.parse(s.buf);
      } catch {}
      if (body !== undefined && s.trial && spentUp(body, 200)) {
        await blockFor(ctx);
        return { $error: { status: 429, message: wordsOf(s.buf, "ZCode's limited quota is exhausted") } };
      }
      if (ctx.request.stream) {
        if (body !== undefined) return { event: 'error', data: body?.type === 'error' ? body : { type: 'error', error: { type: 'api_error', message: wordsOf(s.buf, 'unexpected reply') } } };
        return;
      }
      s.body = body;
    }
    if (ctx.request.stream) return;
    if (s.body === undefined) return { $error: { status: 502, message: 'ZCode answered with no message' } };
    return s.body;
  },
};
