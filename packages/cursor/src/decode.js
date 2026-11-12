// What the Run says, followed into the answer's pieces; and what the server asks the client to run (the v1 plugin's
// decode.mjs as a state machine fed one Connect message at a time, since the host hands the reply over frame by frame).
import { crypto, encoding } from 'astra';
import { EMPTY, field, fields, mapOf, pb, pbNum, pbStr } from './protobuf.js';
import { env, toolDef } from './run.js';
import { failure } from './errors.js';

const badGateway = (message) => ({ status: 502, message });

/**
 * A TurnEndedUpdate as usage. Its input_tokens is the whole prompt, what was read from the cache and written to it included,
 * as Cursor's own client has it; input is that rest, the cache added back for prompt_tokens.
 */
export function usageOf(uf) {
  const [inp, cr, cw] = [pbNum(uf, 1), pbNum(uf, 3), pbNum(uf, 4)];
  return { input: Math.max(inp - cr - cw, 0), output: pbNum(uf, 2), cacheRead: cr, cacheWrite: cw, reasoning: pbNum(uf, 5) };
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

/**
 * Follows one Run. message(bytes) and end(trailer) return the answer's pieces so far: { text } | { reasoning } | { tool } |
 * { stop, usage } (the answer is complete: the caller ends the reply, the Run may stay open) | { error }. send(msg) puts a client
 * message on the Run (BidiAppend).
 *
 * Usage: a turn that ends says what it used (TurnEnded). A step that ends in tool calls is not ended — the Run waits for their
 * results — so Cursor has said nothing of it yet; v1 closed the Run and read the dashboard's usage events for it, which takes
 * longer than a reply call may (2 s). Here such a step's usage is the estimate (prompt: the conversation's size; output: what
 * was said), as v1 had it when the dashboard didn't answer.
 */
export class Decoder {
  constructor({ send, blobs, tools, estimate }) {
    Object.assign(this, { send, blobs, tools, estimate });
    this.calls = 0;
    this.ended = false; // Cursor said what the turn used
    this.listed = 0; // how many tool calls the step makes
    this.said = 0;
    this.wrote = 0; // the reply's text alone; a turn of thinking only says nothing
    this.usage = emptyUsage();
    this.done = false;
    // what the Run sent, for an empty reply to name: the thinking's length, Cursor's own tools refused, updates and messages not read
    this.seen = { thinking: 0, refused: new Map(), updates: new Map(), messages: new Map() };
  }

  count(m, k) {
    m.set(k, (m.get(k) ?? 0) + 1);
  }

  empty(how) {
    this.done = true;
    return { error: badGateway('an empty reply' + emptyWhy(how, this.seen, this.ended ? this.usage : null)) };
  }

  /** The step's end: its usage (a guess only when Cursor counted nothing), and why it stopped. */
  finish() {
    this.done = true;
    const u = this.usage;
    if (!this.ended) {
      u.output ||= Math.floor((this.said + 3) / 4);
      if (!u.input && !u.cacheRead && !u.cacheWrite) u.input = this.estimate;
    }
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    return {
      stop: this.calls > 0 ? 'tool_calls' : 'stop',
      usage: {
        prompt_tokens: prompt,
        completion_tokens: u.output,
        total_tokens: prompt + u.output,
        prompt_tokens_details: { cached_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite },
        ...(u.reasoning ? { completion_tokens_details: { reasoning_tokens: u.reasoning } } : {}),
      },
    };
  }

  closeExec(id) {
    this.send(pb().bytes(5, pb().bytes(1, pb().varint(1, id))).done());
  }

  /** One server message (AgentServerMessage). */
  message(data) {
    const out = [];
    if (this.done) return out;
    for (const m of fields(data)) {
      switch (m.num) {
        case 1: // interaction_update
          for (const u of fields(m.data)) {
            const uf = fields(u.data);
            switch (u.num) {
              case 1: {
                const t = pbStr(uf, 1);
                if (t) {
                  this.said += t.length;
                  this.wrote += t.length;
                  out.push({ text: t });
                }
                break;
              }
              case 4: {
                const t = pbStr(uf, 1);
                if (t) {
                  this.said += t.length;
                  this.seen.thinking += t.length;
                  out.push({ reasoning: t });
                }
                break;
              }
              case 14: // turn ended, with what it used
                this.usage = usageOf(uf);
                this.ended = true;
                if (this.calls === 0) {
                  // nothing written and nothing called: an empty reply, which the client asks again, not a finished turn
                  out.push(this.wrote === 0 ? this.empty('Cursor ended the turn') : this.finish());
                  return out;
                }
                break;
              case 27: // how many tool calls the step makes, sent before them
                this.listed = pbNum(uf, 1);
                if (this.listed > 0 && this.calls >= this.listed) {
                  out.push(this.finish());
                  return out;
                }
                break;
              default:
                this.count(this.seen.updates, u.num);
            }
          }
          break;
        case 2: {
          // exec_server_message: the server asks the client to run something
          const call = this.exec(m.data);
          if (call) {
            this.said += call.args.length;
            out.push({ tool: { index: this.calls++, ...call } });
          }
          if (this.listed > 0 && this.calls >= this.listed) {
            out.push(this.finish()); // every call made: the caller runs them
            return out;
          }
          break;
        }
        case 4: {
          // kv_server_message: a blob wanted, or one to keep
          const kv = fields(m.data);
          const id = pbNum(kv, 1);
          for (const k of kv) {
            if (k.num === 2) {
              const wantF = field(fields(k.data), 1);
              const want = wantF ? encoding.hex.encode(wantF.data) : '';
              const b = this.blobs.get(want);
              const res = b ? pb().bytes(1, b) : pb().bytes(2, pb().str(1, 'blob not found'));
              this.send(pb().bytes(3, pb().varint(1, id).bytes(2, res)).done());
            } else if (k.num === 3) {
              // the server's own record of the turn, not needed
              this.send(pb().bytes(3, pb().varint(1, id).bytes(3, EMPTY)).done());
            }
          }
          break;
        }
        default:
          this.count(this.seen.messages, m.num);
      }
    }
    return out;
  }

  /** The Run's end-of-stream message: its JSON trailer (an error, or none). */
  end(trailer) {
    if (this.done) return [];
    const e = failure(200, trailer ?? '');
    if (e.status < 200 || e.status > 299) {
      this.done = true;
      return [{ error: e }];
    }
    if (this.wrote === 0 && this.calls === 0) return [this.empty(endFrame(trailer))];
    return [this.finish()];
  }

  /** The upstream ended with no end message. */
  eof() {
    if (this.done) return [];
    if (this.calls > 0) return [this.finish()];
    this.done = true;
    return [{ error: badGateway('the reply broke off: EOF') }];
  }

  /** Answers what the server asks the client to run: a call of the caller's tools is returned, the list of them is given, anything else is refused. */
  exec(msg) {
    const es = fields(msg);
    const id = pbNum(es, 1);
    const execID = pbStr(es, 15);
    const answer = (num, res) => {
      this.send(pb().bytes(2, pb().varint(1, id).str(15, execID).bytes(num, res)).done());
      this.closeExec(id);
    };
    for (const e of es) {
      switch (e.num) {
        case 11: {
          // mcp_args: a call of the caller's tools
          const a = fields(e.data);
          const args = mapOf(a, 2);
          const name = pbStr(a, 5) || pbStr(a, 1).replace(/^magpie-/, '');
          // an OpenAI model's id is its call's and its item's, a line apart, which no caller would take as an id: the line goes as __
          const cid = pbStr(a, 3).replaceAll('\n', '__') || 'call_' + encoding.hex.encode(crypto.randomBytes(12));
          return { id: cid, name, args: JSON.stringify(args) };
        }
        case 36: {
          // mcp_state_exec_args: the tools there are
          const srv = pb().str(1, 'magpie').str(2, 'magpie').str(7, 'connected');
          for (const t of this.tools) srv.bytes(5, toolDef(t));
          answer(36, pb().bytes(1, pb().bytes(1, srv)));
          return null;
        }
        case 10: // request_context_args
          answer(10, pb().bytes(1, pb().bytes(1, pb().bytes(4, env()))));
          return null;
      }
    }
    // a shell, a file read or an edit of Cursor's own: never run
    const kind = es.find((e) => e.num !== 1 && e.num !== 15)?.num ?? 0;
    this.count(this.seen.refused, kind);
    this.send(pb().bytes(5, pb().bytes(2, pb().varint(1, id).str(2, 'not available'))).done());
    this.closeExec(id);
    return null;
  }
}

/** How a Run's end message that said no error reads in an empty reply's words. */
function endFrame(t) {
  t = String(t ?? '').trim();
  if (!t || t === '{}') return "the Run's stream ended (an empty end frame)";
  return `the Run's stream ended (end frame: ${t.length > 300 ? t.slice(0, 300) + '…' : t})`;
}

/** What an empty reply says of what came before it: how it ended, the thinking, Cursor's own count, tools refused, what wasn't read. */
function emptyWhy(how, seen, usage) {
  const list = (m) => [...m].map(([k, n]) => (n > 1 ? `#${k} ×${n}` : `#${k}`)).join(', ');
  const parts = [how];
  parts.push(seen.thinking ? `after ${seen.thinking} chars of thinking, no text and no tool call` : 'with no thinking, no text and no tool call');
  if (usage) parts.push(`Cursor counted ${usage.output} output tokens`);
  if (seen.refused.size) parts.push(`Cursor's own tools asked for and refused: ${list(seen.refused)}`);
  if (seen.updates.size) parts.push(`updates not read: ${list(seen.updates)}`);
  if (seen.messages.size) parts.push(`messages not read: ${list(seen.messages)}`);
  return ` (${parts.join('; ')}; try again)`;
}
