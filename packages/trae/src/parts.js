// Trae: turning its events into what the answer is made of — text, reasoning, tool calls, token counts, the finish.
// The host cuts the reply into SSE frames and calls the provider's transformResponse for each, so the v1 generator
// (`parts`) is the push-style `Answer` here: push(event, data) → the parts that event made, end() → the rest.
import { callId, NativeCalls } from './native-calls.js';
import { errorOf } from './errors.js';
import { TextTools } from './text-tools.js';
import { toolNamed, unwrapped } from './tools.js';

// normalised event names: "TokenUsage", "token-usage" → token_usage
export const eventName = (s) =>
  String(s ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_|_$/g, '');

// tokensOf maps Trae's token counts to OpenAI's
export function tokensOf(u) {
  if (!u || typeof u !== 'object') return null;
  const p = Number(u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? u.inputTokens ?? 0) || 0;
  const c = Number(u.completion_tokens ?? u.output_tokens ?? u.completionTokens ?? u.outputTokens ?? 0) || 0;
  if (!p && !c) return null;
  return { prompt_tokens: p, completion_tokens: c, total_tokens: Number(u.total_tokens ?? u.totalTokens) || p + c };
}

// the events that carry the answer: output and message, and the names Trae has put a reply's text under otherwise
// (delta, or none at all); any other is queueing, metadata or timing
const ANSWER = new Set(['', 'output', 'message', 'delta', 'content', 'text', 'answer', 'chunk', 'output_delta', 'message_delta']);

// finishOf is OpenAI's finish_reason for the one Trae's last event gives, "" for none it says or one it has no word for
export function finishOf(d) {
  const f = String(d?.finish_reason ?? d?.stop_reason ?? d?.finishReason ?? '').toLowerCase();
  if (['length', 'max_tokens', 'max_output_tokens', 'max_length'].includes(f)) return 'length';
  if (f === 'content_filter' || f === 'sensitive') return 'content_filter';
  return '';
}

// Thoughts is the reasoning sent on so far: a piece Trae sends again (the same one twice in a row, or the reasoning
// so far, again or with more after it) sends only what is new
export class Thoughts {
  constructor() {
    this.all = '';
    this.last = '';
  }
  add(r) {
    const last = this.last;
    this.last = r;
    if (r === last && r.length >= 8) return '';
    if (this.all.length >= 16 && r.length >= 16 && this.all.endsWith(r)) return '';
    if (this.all.length >= 16 && r.startsWith(this.all)) r = r.slice(this.all.length);
    this.all += r;
    return r;
  }
}

// Answer turns Trae's events into parts: { text } | { reasoning } | { call } | { usage } | { finish } | { error, code }.
// tools are the request's, a call to one named otherwise going on under its name. An error part ends the answer.
export class Answer {
  constructor(tools = [], realm = 'Trae CN') {
    this.tools = tools;
    this.realm = realm;
    this.tt = new TextTools(tools);
    this.nc = new NativeCalls();
    this.th = new Thoughts();
    this.finish = '';
    this.over = false;
    this.errored = false;
    this.flushed = false;
  }

  call(c) {
    const name = toolNamed(c.name, this.tools);
    return { call: { ...c, name, arguments: unwrapped(c.arguments, name, this.tools) } };
  }

  // what the text tools took out of the text so far: its reasoning, text and calls, then the error that ends the answer
  fromText(r, out) {
    const t = r.reasoning && this.th.add(r.reasoning);
    if (t) out.push({ reasoning: t });
    if (r.text) out.push({ text: r.text });
    for (const c of r.calls) out.push(this.call({ ...c, id: callId() }));
    if (r.error) {
      out.push({ error: r.error, code: null });
      this.over = this.errored = true;
    }
  }

  push(event, data) {
    const out = [];
    if (this.over) return out;
    const name = eventName(event);
    const d = data && typeof data === 'object' ? data : {};
    if (data === '[DONE]') {
      this.over = true;
      return out;
    }
    if (name === 'error' || (name !== 'output' && d.code && d.message && !d.response && !d.content)) {
      const e = errorOf(d);
      // (named for Trae CN, as it always was, whichever realm answered)
      out.push({ error: e.message || 'Trae CN returned an error', code: e.code });
      this.over = this.errored = true;
      return out;
    }
    if (name === 'token_usage') {
      const u = tokensOf(d.usage ?? d);
      if (u) out.push({ usage: u });
      return out;
    }
    if (name === 'done' || name === 'response_done' || name === 'stream_done') {
      const u = tokensOf(d.usage);
      if (u) out.push({ usage: u });
      this.finish = finishOf(d) || this.finish;
      this.over = true;
      return out;
    }
    if (!ANSWER.has(name)) return out;
    const delta = d.delta && typeof d.delta === 'object' ? d.delta : {};
    const reasoning = d.reasoning_content ?? d.reasoning ?? delta.reasoning_content ?? '';
    if (typeof reasoning === 'string' && reasoning) {
      const r = this.th.add(reasoning);
      if (r) out.push({ reasoning: r });
    }
    let text = typeof d.response === 'string' ? d.response : typeof d.content === 'string' ? d.content : typeof delta.content === 'string' ? delta.content : typeof d.delta === 'string' ? d.delta : '';
    // the IDE's own progress notes, not the model's
    if (/^(Building prompt:|Completed building prompt)/.test(text)) text = '';
    if (text) {
      this.fromText(this.tt.push(text), out);
      if (this.over) return out;
    }
    for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) this.nc.push(tc);
    const u = tokensOf(d.usage);
    if (u) out.push({ usage: u });
    this.finish = finishOf(d) || this.finish;
    return out;
  }

  // the stream is over (its done event or its end): what the text tools held back, the native calls, the finish
  end() {
    const out = [];
    if (this.errored || this.flushed) return out;
    this.flushed = true;
    this.fromText(this.tt.push('', true), out);
    if (this.errored) return out;
    for (const c of this.nc.take(this.tools)) out.push(this.call(c));
    if (this.finish) out.push({ finish: this.finish });
    return out;
  }
}
