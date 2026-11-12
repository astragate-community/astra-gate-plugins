// A chat on Cursor's agent API: what prepare puts up and hands the host, and the reply's Connect frames as a chat completion.
// The server's messages are built with the plugin's own protobuf writer, field numbers as the v1 plugin's tests had them.
import { afterEach, describe, expect, it } from 'vitest';
import { runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin from '../src/main.js';
import { close, runs } from '../src/agent.js';
import { field, fields, pb, pbStr, pbValue, text } from '../src/protobuf.js';
import { PERMS, claude, live } from './support.js';

const account = { key: 'me@x.io', secret: JSON.stringify({ type: 'oauth', access: live(), refresh: 'none', expires: 0 }) };
const opts = (fetch, storage = {}) => ({ permissions: PERMS, fetch, storage });

const chatReq = (body, stream = true) => ({ provider: 'cursor', protocol: 'chat', model: body.model, path: '/v1/chat/completions', method: 'POST', headers: {}, body: { ...body, stream }, stream });

/** A fake Cursor: the model lists, and every BidiAppend's client message kept (decoded from its hex). */
function cursor({ appendStatus = 200 } = {}) {
  const appends = [];
  const fetch = async (req) => {
    if (req.url.endsWith('AvailableModels')) return { status: 200, body: { models: [claude] } };
    if (req.url.endsWith('GetUsableModels')) return { status: 200, body: { models: [] } };
    if (req.url.endsWith('BidiService/BidiAppend')) {
      const f = fields(Buffer.from(req.body, 'base64'));
      appends.push({ id: pbStr(f, 2) ? pbStr(fields(field(f, 2).data), 1) : '', n: field(f, 3)?.n ?? 0, msg: Buffer.from(pbStr(f, 1), 'hex'), headers: req.headers });
      return appendStatus === 200 ? { status: 200, body: '' } : { status: appendStatus, body: { code: 'unauthenticated', message: 'bad token' } };
    }
    return { status: 404, body: {} };
  };
  return { fetch, appends };
}

// the server's messages
const update = (num, msg) => pb().bytes(1, pb().bytes(num, msg)).done();
const textDelta = (t) => update(1, pb().str(1, t));
const thinking = (t) => update(4, pb().str(1, t));
const turnEnded = (input, output, cacheRead = 0) => update(14, pb().varint(1, input).varint(2, output).varint(3, cacheRead));
const toolCount = (n) => update(27, pb().varint(1, n));
const toolCall = (execId, callId, name, args) => {
  const a = pb().str(1, 'magpie-' + name).str(3, callId).str(5, name);
  for (const [k, v] of Object.entries(args)) a.bytes(2, pb().str(1, k).bytes(2, pbValue(v)));
  return pb().bytes(2, pb().varint(1, execId).str(15, 'exec-' + execId).bytes(11, a)).done();
};
const blobWanted = (kvId, blobId) => pb().bytes(4, pb().varint(1, kvId).bytes(2, pb().bytes(1, blobId))).done();
const data = (msg) => ({ flags: 0, bytes: Buffer.from(msg).toString('base64') });
const endOf = (json) => ({ flags: 2, end: true, json });

afterEach(() => {
  for (const id of [...runs.keys()]) close(id);
});

describe('prepare', () => {
  it('puts the run request up as BidiAppend 0 and hands the host the RunSSE request as a Connect frame', async () => {
    const { fetch, appends } = cursor();
    const r = await runProvider(plugin, 'cursor', 'prepare', chatReq({ model: 'claude-x@200k', reasoning_effort: 'high', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] }), account, opts(fetch));
    expect(r.url).toBe('https://api2.cursor.sh/agent.v1.AgentService/RunSSE');
    expect(r.headers['content-type']).toBe('application/connect+proto');
    expect(r.headers.authorization).toMatch(/^Bearer /);
    expect(r.body).toBeUndefined();
    const id = r.state.id;
    expect(r.headers['x-request-id']).toBe(id);
    // the body: one Connect frame (flags 0, length) holding { 1: request id }
    const body = Buffer.from(r.bodyBase64, 'base64');
    expect(body[0]).toBe(0);
    expect(body.readUInt32BE(1)).toBe(body.length - 5);
    expect(pbStr(fields(body.subarray(5)), 1)).toBe(id);

    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({ id, n: 0 });
    // AgentClientMessage { run_request (1) { requested_model (9) { model_id (1), parameters (3) } } }
    const rr = fields(field(fields(appends[0].msg), 1).data);
    const requested = fields(field(rr, 9).data);
    expect(pbStr(requested, 1)).toBe('claude-x-high'); // the variant at that effort and size, by its own id
    expect(r.state).toMatchObject({ model: 'claude-x@200k', cursorModel: 'claude-x-high' });
    expect(runs.has(id)).toBe(true);
  });

  it('a model the list does not have goes by its name; auto is default', async () => {
    const { fetch, appends } = cursor();
    await runProvider(plugin, 'cursor', 'prepare', chatReq({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }), account, opts(fetch));
    const rr = fields(field(fields(appends[0].msg), 1).data);
    expect(pbStr(fields(field(rr, 9).data), 1)).toBe('default');
  });

  it('a run request Cursor refuses fails prepare with its words, and nothing is left running', async () => {
    const { fetch } = cursor({ appendStatus: 401 });
    await expect(runProvider(plugin, 'cursor', 'prepare', chatReq({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }), account, opts(fetch))).rejects.toThrow(/bad token/);
    expect(runs.size).toBe(0);
  });
});

describe('the reply', () => {
  const prepared = async (fetch, body = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, stream = true) =>
    (await runProvider(plugin, 'cursor', 'prepare', chatReq(body, stream), account, opts(fetch))).state;
  const reply = (fetch, state, frames, stream = true) =>
    runResponse(plugin, 'cursor', { framing: 'connect', frames, state, request: { protocol: 'chat', model: state.model, stream } }, opts(fetch));

  it('text and thinking stream as chat chunks; the ended turn says its usage and ends the reply', async () => {
    const { fetch } = cursor();
    const state = await prepared(fetch);
    const r = await reply(fetch, state, [data(thinking('hmm')), data(textDelta('Hel')), data(textDelta('lo')), data(turnEnded(120, 7, 100)), data(textDelta('never'))]);
    expect(r.ended).toBe(true);
    expect(r.consumed).toBe(4);
    const deltas = r.frames.map((f) => f.choices[0].delta);
    expect(deltas).toEqual([{ role: 'assistant', content: '' }, { reasoning_content: 'hmm' }, { content: 'Hel' }, { content: 'lo' }, {}]);
    const last = r.frames.at(-1);
    expect(last.choices[0].finish_reason).toBe('stop');
    // input_tokens is the whole prompt; the cache's part is said apart
    expect(last.usage).toMatchObject({ prompt_tokens: 120, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 100 } });
    expect(r.frames.every((f) => f.model === 'auto' && f.object === 'chat.completion.chunk')).toBe(true);
    expect(runs.has(state.id)).toBe(false); // disposed
  });

  it("answers the server's blob request with the blob, and the step's tool calls end the reply as tool_calls", async () => {
    const { fetch, appends } = cursor();
    const state = await prepared(fetch, {
      model: 'auto',
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    });
    // the first blob the run request names (conversation_state.messages): the system prompt, which lists the caller's tools
    const rr = fields(field(fields(appends[0].msg), 1).data);
    const blobId = field(fields(field(rr, 1).data), 1).data;
    const r = await reply(fetch, state, [data(blobWanted(9, blobId)), data(toolCount(1)), data(toolCall(5, 'call_1', 'get_weather', { city: 'Paris' }))]);
    await new Promise((res) => setTimeout(res, 20));
    const kv = appends.map((a) => field(fields(a.msg), 3)).find(Boolean);
    expect(kv).toBeTruthy();
    const kvf = fields(kv.data);
    expect(field(kvf, 1).n).toBe(9);
    const blob = field(fields(field(kvf, 2).data), 1).data;
    const sys = JSON.parse(text(blob));
    expect(sys.role).toBe('system');
    expect(sys.content).toContain('CallDynamicTool({"namespace":"magpie","toolName":"get_weather"');
    expect(appends.map((a) => a.n)).toEqual(appends.map((_, i) => i)); // numbered in order

    expect(r.ended).toBe(true);
    const call = r.frames.find((f) => f.choices[0].delta.tool_calls);
    expect(call.choices[0].delta.tool_calls[0]).toEqual({ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } });
    expect(r.frames.at(-1).choices[0].finish_reason).toBe('tool_calls');
  });

  it("refuses Cursor's own tools (a shell) and tells the server so", async () => {
    const { fetch, appends } = cursor();
    const state = await prepared(fetch);
    const shell = pb().bytes(2, pb().varint(1, 3).str(15, 'exec-3').bytes(14, pb().str(1, 'rm -rf /'))).done();
    await reply(fetch, state, [data(shell), data(textDelta('ok')), data(turnEnded(10, 1))]);
    await new Promise((res) => setTimeout(res, 20));
    const refusal = appends.map((a) => field(fields(a.msg), 5)).filter(Boolean).map((f) => fields(f.data)).find((f) => field(f, 2));
    expect(pbStr(fields(field(refusal, 2).data), 2)).toBe('not available');
  });

  it('a non-streaming request gets one chat.completion body', async () => {
    const { fetch } = cursor();
    const state = await prepared(fetch, undefined, false);
    const r = await reply(fetch, state, [data(textDelta('Hi')), data(turnEnded(5, 1))], false);
    expect(r.failure).toBeNull();
    expect(r.body).toMatchObject({ object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5 } });
  });

  it("the Run's end trailer error is the reply's status: out of usage is a 429", async () => {
    const { fetch } = cursor();
    const state = await prepared(fetch);
    const r = await reply(fetch, state, [endOf({ error: { code: 'resource_exhausted', message: 'You have hit your usage limit' } })]);
    expect(r.failure).toMatchObject({ status: 429 });
    expect(r.failure.message).toMatch(/usage limit/);
  });

  it('an empty turn is a 502 that says what came, not a finished answer', async () => {
    const { fetch } = cursor();
    const state = await prepared(fetch);
    const r = await reply(fetch, state, [data(thinking('...')), data(turnEnded(10, 3))]);
    expect(r.failure).toMatchObject({ status: 502 });
    expect(r.failure.message).toMatch(/empty reply.*thinking/);
  });

  it('a model Cursor serves only in Max Mode is remembered for the next request', async () => {
    const { fetch, appends } = cursor();
    const storage = {};
    const state = (await runProvider(plugin, 'cursor', 'prepare', chatReq({ model: 'big-model', messages: [{ role: 'user', content: 'hi' }] }), account, opts(fetch, storage))).state;
    const r = await runResponse(plugin, 'cursor', { framing: 'connect', frames: [endOf({ error: { code: 'invalid_argument', message: 'Max Mode Required' } })], state }, opts(fetch, storage));
    expect(r.failure.message).toMatch(/Max Mode.*try again/);
    const kept = JSON.parse(globalThis.__astraTestHost.storage.get('maxOnly'));
    expect(kept).toEqual(['big-model']);
    await runProvider(plugin, 'cursor', 'prepare', chatReq({ model: 'big-model', messages: [{ role: 'user', content: 'hi' }] }), account, opts(fetch, { maxOnly: kept }));
    const rr = fields(field(fields(appends.at(-1).msg), 1).data);
    expect(field(fields(field(rr, 9).data), 2)?.n).toBe(1); // requested_model.max_mode
  });

  it('a refused RunSSE is answered with its status at start', async () => {
    const { fetch } = cursor();
    const state = await prepared(fetch);
    const r = await runResponse(plugin, 'cursor', { framing: 'connect', frames: [], state, response: { status: 401, body: '{"code":"unauthenticated","message":"Not logged in"}' } }, opts(fetch));
    expect(r.error).toMatchObject({ status: 401 });
    expect(runs.has(state.id)).toBe(false);
  });
});
