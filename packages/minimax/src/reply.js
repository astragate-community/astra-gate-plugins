// MiniMax Code's reply (manifest `reply`: sse, anthropic). Two jobs:
//  - an out-of-credits refusal (402/403 whose text is about credits, balance or the plan) becomes a 429, so another
//    account can take over (the v1 reply guard);
//  - MiniMax is always asked to stream (prepare), and a client that wanted one JSON message gets the stream put back
//    together in `end`.
import { anthropicAccumulator } from './accumulate.js';

// QUOTA says a refusal is about the account's credits or plan running out.
export const QUOTA = /insufficient|balance|credit|quota|exhaust|limit|余额|积分|额度|不足|用完|上限/i;

/** The words of a refusal body: its error message when it is JSON, else the text. */
export function refusalMessage(text) {
  let msg = String(text ?? '').trim();
  try {
    const v = JSON.parse(text);
    msg = v?.error?.message ?? v?.message ?? v?.msg ?? v?.base_resp?.status_msg ?? msg;
  } catch {}
  return msg;
}

const failed = (message, status = 502) => ({ $error: { status, message } });

export const transformResponse = {
  start(res, ctx) {
    ctx.state.acc = ctx.request.stream ? null : anthropicAccumulator();
    ctx.state.completed = false;
    if ((res.status === 402 || res.status === 403) && QUOTA.test(res.body ?? '')) {
      return { error: { status: 429, message: 'usage limit reached: ' + refusalMessage(res.body) } };
    }
  },

  frame(f, ctx) {
    const s = ctx.state;
    if (s.cut) return;
    const data = f.json;
    if (f.event === 'error' || data?.type === 'error') {
      s.cut = true;
      const message = data?.error?.message ?? (typeof f.data === 'string' && f.data) ?? 'Upstream stream failed';
      // a stream carries the upstream's own error event on; a one-body reply is a failure
      return ctx.request.stream ? { event: 'error', data: data ?? { type: 'error', error: { type: 'api_error', message } } } : failed(message);
    }
    if (!data || typeof data !== 'object') return; // a comment or keep-alive without JSON
    const type = f.event ?? data.type;
    if (type === 'message_stop') s.completed = true;
    if (s.acc) {
      try {
        s.acc.apply(data, type);
      } catch (e) {
        s.cut = true;
        return failed(e.message);
      }
      return;
    }
    return type ? { event: type, data } : data;
  },

  end(ctx) {
    const s = ctx.state;
    if (s.cut) return;
    if (!s.completed) return failed('Upstream SSE ended without a completion marker');
    if (!s.acc) return;
    try {
      return s.acc.finish();
    } catch (e) {
      return failed(e.message);
    }
  },
};
