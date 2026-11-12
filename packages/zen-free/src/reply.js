// Zen's reply, frame by frame (manifest `reply`: sse). Three jobs, as in the v1 plugin:
//  - the tool guard: a reply may only call tools the agent declared (up to case and separators); a chat stream's tool
//    calls are held back until their choice finishes, so a call is shown only once its whole name is known and checked;
//  - the stream collapse: Zen is always asked to stream (prepare), and a client that wanted one JSON body gets the
//    stream put back together in `end`;
//  - events leave in the client's own protocol (chat: bare data events; responses / anthropic: { event, data } pairs).
import { chatBuffer } from './chat-buffer.js';
import { accumulatorFor } from './accumulators.js';
import { GuardError, failure, parseJSON } from './guard-core.js';
import { endsStream, isFailureEvent } from './sse-util.js';
import { checkSnapshots } from './snapshots.js';
import { nameGuard } from './tool-names.js';

// ---- what prepare declared, for the reply of the same request ------------------------------------------------
// The reply side sees the model but not the request, so prepare leaves the tool names the agent declared here (one
// engine runs both). Several requests of one model may be in flight: a reply is checked against the union of the
// unfinished ones, which can only let more through, never refuse a call the agent did declare. Entries that never finish
// (a client that went away) expire.
const TTL_MS = 15 * 60_000;
const MAX_PENDING = 256;
const pending = new Map();

export function expect(model, declared) {
  const now = Date.now();
  const list = (pending.get(model) ?? []).filter((e) => now - e.at < TTL_MS);
  list.push({ at: now, declared, claimed: false });
  while (list.length > MAX_PENDING) list.shift();
  pending.set(model, list);
}

function claim(model) {
  const list = pending.get(model) ?? [];
  const entry = list.find((e) => !e.claimed);
  if (entry) entry.claimed = true;
  return { entry, list };
}

function release(state) {
  const list = pending.get(state.model);
  if (!list || !state.entry) return;
  const i = list.indexOf(state.entry);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) pending.delete(state.model);
}

function policyFor(state) {
  if (!state.entry) return null;
  const declared = new Set(state.entry.declared);
  for (const e of pending.get(state.model) ?? []) for (const name of e.declared) declared.add(name);
  return { declared };
}

/** For tests: forget everything prepare left. */
export function forget() {
  pending.clear();
}

// ---- the transform ---------------------------------------------------------------------------------------------

const message = (e) => (e instanceof GuardError || e instanceof Error ? e.message : String(e));
const refuse = (e) => ({ $error: { status: 502, message: message(e) } });

function errorMessage(value, fallback = 'Upstream stream failed') {
  if (typeof value === 'string' && value) return value;
  return value?.message || value?.error?.message || fallback;
}

// an event as the client's protocol writes it
function shaped(protocol, data, name) {
  if (protocol === 'chat') return data;
  const event = name || data?.type;
  return event ? { event, data } : data;
}

export const transformResponse = {
  start(res, ctx) {
    const s = ctx.state;
    s.protocol = ctx.request.protocol;
    s.model = ctx.request.model;
    if (res.status < 200 || res.status >= 300) {
      // a refusal goes through as it came (the host calls neither frame nor end for it)
      return;
    }
    const { entry } = claim(s.model);
    s.entry = entry;
    // no word from prepare (a reloaded engine): nothing to check names against, so none are
    s.checkName = entry ? nameGuard(policyFor(s)) : null;
    s.chat = s.protocol === 'chat' && s.checkName ? chatBuffer(s.checkName) : null;
    s.acc = ctx.request.stream ? null : accumulatorFor(s.protocol);
    s.completed = false;
    s.stopped = false;
  },

  frame(f, ctx) {
    const s = ctx.state;
    if (s.stopped) return;
    const protocol = s.protocol;
    const out = [];
    const emit = (data, name) => {
      if (s.acc) s.acc.apply(data, name || data?.type);
      else out.push(shaped(protocol, data, name));
    };
    try {
      const text = f.data ?? '';
      if (f.event !== 'error' && !text.trim()) return;
      if (f.event !== 'error' && text.trim() === '[DONE]') {
        if (protocol !== 'chat') throw new GuardError('Unexpected upstream completion marker');
        const final = s.chat?.finish();
        s.completed = true;
        s.stopped = true;
        if (final) emit(final);
        if (ctx.request.stream) out.push('[DONE]');
        release(s);
        return out;
      }
      let data = null;
      if (f.event !== 'error') {
        if (f.json === undefined) throw new GuardError('Invalid JSON in upstream response');
        data = f.json;
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GuardError('Invalid JSON object in upstream response');
      }
      const type = data?.type ?? f.event;
      if (f.event === 'error' || isFailureEvent(data, type)) {
        s.stopped = true;
        s.cut = true;
        release(s);
        // the upstream's own failure, in the shape it came in
        if (!ctx.request.stream) return { $error: { status: 502, message: errorMessage(data?.error ?? data?.response?.error ?? data ?? text) } };
        let raw = data;
        if (raw === null) {
          try { raw = JSON.parse(text); } catch { raw = { error: { message: text } }; }
        }
        return shaped(protocol, raw, f.event === 'error' || protocol !== 'chat' ? 'error' : undefined);
      }
      let result = data;
      if (s.chat) result = s.chat.apply(data).data;
      else if (s.checkName) checkSnapshots(data, protocol, s.checkName);
      if (endsStream(protocol, type)) s.completed = true;
      if (result) emit(result, f.event);
    } catch (e) {
      s.stopped = true;
      s.cut = true;
      release(s);
      if (e instanceof GuardError && ctx.request.stream) {
        // cut the stream with an error event of the protocol, as the v1 guard did
        out.push(shaped(protocol, failure(protocol, e.message, true), protocol === 'chat' ? undefined : 'error'));
        return out;
      }
      return refuse(e);
    }
    return out;
  },

  end(ctx) {
    const s = ctx.state;
    release(s);
    if (s.cut) return; // already refused or cut with an error
    if (!s.completed || s.chat?.size) return refuse(new GuardError('Upstream SSE ended without a completion marker'));
    if (!s.acc) return;
    try {
      return s.acc.finish();
    } catch (e) {
      return refuse(e);
    }
  },
};
