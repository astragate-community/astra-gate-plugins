// Turning Zed's reply back into the provider's own (08 §2.2): the host cuts it into NDJSON lines, `frame` gives each one's event,
// and the result is the provider's stream, or (a caller that didn't ask for a stream) one whole reply.
//
// What comes before the reply says anything is held, as magpie's built-in holds it (relayStatus): a failure there (a failed
// status, the provider's own error event, a reply that broke off or ended without an answer) is answered as a refused request
// with its status (a 429, a 402 is another account's turn), not a 200 whose stream carries it. The host reads frames until the
// first output byte, so a `$error` returned before it becomes the reply's status.
import { assemble } from './assemble.js';
import { errorStatusOf, failedStatus, refusal } from './api.js';
import { eventError, out, said } from './wire.js';

const fail = (status, message) => ({ $error: { status, message } });

export const transformResponse = {
  start(res, ctx) {
    if (res.status < 200 || res.status > 299) {
      const [status, message] = refusal(res.status, res.body);
      return { error: { status, message } };
    }
    // whether the reply said it sends statuses (and so ends with stream_ended)
    ctx.state.wrapped = !!res.headers['x-zed-server-supports-status-messages'];
    ctx.state.head = [];
    ctx.state.events = [];
  },

  frame(f, ctx) {
    const st = ctx.state;
    const wire = ctx.request.protocol;
    if (f.json === undefined) {
      if (typeof f.text === 'string' && !f.text.trim()) return;
      return fail(502, 'Zed: an unreadable line');
    }
    const j = f.json;
    let ev;
    if (!st.wrapped) ev = j;
    else if (j && j.event !== undefined) ev = j.event;
    else if (j?.status === 'stream_ended') {
      st.ended = true;
      return;
    } else if (j?.status?.failed) {
      const failed = j.status.failed;
      const message = failed.message || failed.code;
      // before the reply began: a refused request with its status; after it, not clamped (the stream already said 200)
      return fail(st.began ? failedStatus(failed.code) : errorStatusOf(failed.code), message);
    } else return; // "started", {"queued": …} and newer statuses say nothing to act on

    if (!ctx.request.stream) {
      const bad = eventError(wire, ev);
      if (bad !== undefined) return fail(502, bad);
      st.events.push(ev);
      return;
    }
    if (st.began) return out(wire, ev);
    const bad = eventError(wire, ev);
    if (bad !== undefined) return fail(502, bad);
    if (!said(wire, ev)) {
      st.head.push(ev);
      return;
    }
    st.began = true;
    return [...st.head, ev].map((e) => out(wire, e));
  },

  end(ctx) {
    const st = ctx.state;
    const wire = ctx.request.protocol;
    // Zed ends every whole reply with stream_ended
    if (st.wrapped && !st.ended) return fail(502, 'the reply ended before it was complete');
    if (!ctx.request.stream) {
      const body = assemble(wire, st.events);
      return body ? body : fail(502, 'the reply ended before it was complete');
    }
    if (!st.began) return fail(502, 'Zed ended without an answer');
    return wire === 'chat' ? '[DONE]' : undefined;
  },
};
