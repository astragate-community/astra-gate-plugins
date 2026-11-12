import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mount, runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin, { signIn, signInCn } from '../src/main.js';
import { SITES } from '../src/constants.js';
import { cosyHeaders } from '../src/cosy.js';
import { effortFor, fitEffort, qoderBody, qoderMessages, windowFor } from '../src/request.js';
import { freeOf, modelInfo, modelInfos, rateOf, sceneModels, windowsOf } from '../src/models.js';
import { failure } from '../src/refusals.js';
import { Splitter, parseCall } from '../src/toolcalls.js';
import { challengeOf, pollDeviceToken } from '../src/signin.js';
import { hostJson } from '../src/util.js';

const PERMS = ['providers', 'ui', 'net:https://api3.qoder.sh', 'net:https://openapi.qoder.sh', 'net:https://gateway.qoder.com.cn', 'net:https://openapi.qoder.com.cn'];
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });
const secretOf = (extra = {}) => JSON.stringify({ access: 'job', refresh: 'r1', expires: Date.now() + 3600e3, uid: 'u1', machineId: 'm1', deviceToken: 'dev', deviceRefresh: 'dr', email: 'a@b.c', ...extra });
const user = { access: 'job', uid: 'u1', machineId: 'm1', email: 'a@b.c' };
const host = () => globalThis.__astraTestHost;

const thinker = { key: 'k', source: 's', thinks: true, alwaysThinks: false, efforts: ['low', 'high', 'max'], defaultEffort: 'high', windows: [], context: 180_000, config: { key: 'k' } };
const listing = { chat: [{ key: 'perf', enable: true, source: 'qoder', display_name: 'Performance', max_input_tokens: 180_000, price_factor: 1.1, is_vl: true }] };

function net(route) {
  const calls = [];
  return { calls, opts: { permissions: PERMS, fetch: async (req) => (calls.push(req), route(req)) } };
}
const account = { key: 'a@b.c' };
const chatReq = (extra = {}) => ({ protocol: 'chat', provider: 'qoder', model: 'perf', path: '/v1/chat/completions', method: 'POST', headers: {}, body: { model: 'perf', messages: [{ role: 'user', content: 'ping' }] }, stream: true, ...extra });
const call = (what, req, secret, route = () => json({}), provider = 'qoder') => {
  const n = net(route);
  return runProvider(plugin, provider, what, req, secret === undefined ? null : { ...account, secret }, n.opts).then((out) => ({ out, calls: n.calls }));
};

describe('hostJson', () => {
  it('writes what System.Text.Json does: quotes, HTML-sensitive and non-ASCII characters escaped in upper case', () => {
    // vector from the host's own serializer (JsonNode.ToJsonString) over the same value
    const v = { a: 'q"b\\ <>&\'+`~ \u007f é 😀 \n\t\u0001', n: [1.5, 1e3, 0.1, true, null] };
    expect(hostJson(v)).toBe('{"a":"q\\u0022b\\\\ \\u003C\\u003E\\u0026\\u0027\\u002B\\u0060~ \\u007F \\u00E9 \\uD83D\\uDE00 \\n\\t\\u0001","n":[1.5,1000,0.1,true,null]}');
    expect(JSON.parse(hostJson(v))).toEqual(v);
  });
});

describe('COSY', () => {
  it('carries the machine and a signature over payload, key, time, body and path', () => {
    const h = cosyHeaders('https://api3.qoder.sh/algo/api/v2/model/list?Encode=1', user, 'BODY', 1700000000);
    expect(h['Cosy-Date']).toBe('1700000000');
    expect(h['Cosy-MachineId']).toBe('m1');
    expect(h['Cosy-User']).toBe('u1');
    const m = /^Bearer COSY\.([^.]+)\.([0-9a-f]{32})$/.exec(h.Authorization);
    expect(m).toBeTruthy();
    expect(createHash('md5').update(`${m[1]}\n${h['Cosy-Key']}\n1700000000\nBODY\n/api/v2/model/list`).digest('hex')).toBe(m[2]);
    const payload = JSON.parse(Buffer.from(m[1], 'base64').toString());
    expect(payload).toMatchObject({ version: 'v1', cosyVersion: '1.1.49' });
    expect(Buffer.from(payload.info, 'base64').length % 16).toBe(0); // AES-CBC blocks
    expect(Buffer.from(h['Cosy-Key'], 'base64').length).toBe(128); // 1024-bit RSA
    expect(() => cosyHeaders('https://x/y', { ...user, machineId: '' }, '')).toThrow(/machine id/);
  });

  it('wraps a fresh key each time', () => {
    expect(cosyHeaders('https://x/y', user, '').Authorization).not.toBe(cosyHeaders('https://x/y', user, '').Authorization);
  });
});

describe('models', () => {
  it('free only at 0x, a discount is not free, and the strike-through price', () => {
    expect(freeOf({ price_factor: 0 })).toBe(true);
    expect(freeOf({ price_factor: 0.5, is_free: true })).toBe(false);
    expect(freeOf({ price_factor: 0, promotion: { active: true, before_promotion_price_factor: 1.1 } })).toBe(false);
    expect(freeOf({ is_free: true })).toBe(true);
    expect(rateOf({ price_factor: 0, original_price_factor: 0.1 })).toEqual({ rate: 0, rateWas: 0.1 });
    expect(rateOf({ price_factor: 0, promotion: { active: true, before_promotion_price_factor: 1, discount_factor: 0.4 } })).toEqual({ rate: 0.4, rateWas: 1 });
    expect(rateOf({})).toEqual({ rate: 0, rateWas: 0 });
  });

  it('context windows come from context_config, else the available list', () => {
    expect(windowsOf({ context_config: { '1m': { token_count: 1_000_000 }, '200k': { token_count: 200_000, is_default: true } } })).toEqual({ windows: [200_000, 1_000_000], defaultWindow: 200_000 });
    expect(windowsOf({ available_context_windows: [400_000, 200_000], default_context_window: 200_000 })).toEqual({ windows: [200_000, 400_000], defaultWindow: 200_000 });
    expect(windowsOf({})).toEqual({ windows: [], defaultWindow: 0 });
  });

  it('modelInfo reads efforts in rank order, the default and always-thinking', () => {
    const m = modelInfo({ key: 'k', display_name: 'K', is_vl: true, max_input_tokens: 180_000, thinking_config: { enabled: { efforts: { max: {}, low: {}, high: { is_default: true } } } } });
    expect([m.name, m.images, m.context, m.thinks, m.alwaysThinks, m.efforts, m.defaultEffort]).toEqual(['K', true, 180_000, true, true, ['low', 'high', 'max'], 'high']);
    expect(modelInfo({ key: 'j', thinking_config: { enabled: {}, disabled: {} } }).alwaysThinks).toBe(false);
  });

  it("lists the app's models in order, keeps a chat-only one after its neighbour, drops auto and disabled", () => {
    const l = { app: [{ key: 'fast', enable: true }, { key: 'auto', enable: true }, { key: 'x', enable: true }], chat: [{ key: 'fast', enable: true }, { key: 'performance', enable: true }, { key: 'x' }] };
    expect(sceneModels(l).map((m) => m.key)).toEqual(['fast', 'performance', 'auto', 'x']);
    expect(modelInfos(l).map((m) => m.key)).toEqual(['fast', 'performance', 'x']);
    expect(modelInfos({ chat: [{ key: 'a', enable: false }, { key: 'b', enable: true }] }).map((m) => m.key)).toEqual(['b']);
  });
});

describe('request shaping', () => {
  it('effort: none, default, always-thinking and the nearest level', () => {
    expect(effortFor('none', thinker)).toEqual([false, '']);
    expect(effortFor(undefined, thinker)).toEqual([true, 'high']);
    expect(effortFor('none', { ...thinker, alwaysThinks: true })).toEqual([true, 'low']);
    expect(effortFor('bogus', thinker)).toEqual([true, 'high']);
    expect(effortFor('xhigh', thinker)).toEqual([true, 'max']);
    expect(effortFor('low', { ...thinker, thinks: false })).toEqual([false, '']);
    expect(fitEffort('ultra', ['low', 'max'])).toBe('max');
    expect(fitEffort('medium', ['low', 'high'])).toBe('high'); // a tie goes up
  });

  it("puts tool images in a user turn after the tool's text, and keeps an assistant's tool calls", () => {
    const out = qoderMessages([
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'shot', arguments: { a: 1 } } }] },
      { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'done' }, { type: 'image_url', image_url: { url: 'data:x' } }] },
      { role: 'user', content: 'and?' },
    ]);
    expect(out[1]).toEqual({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shot', arguments: '{"a":1}' } }] });
    expect(out[2].content).toBe('done\n\n[The tool returned an image; it follows in the next message.]');
    expect(out[3].content.map((b) => b.type)).toEqual(['text', 'image_url', 'text']);
    expect(out[3].content[0].text).toBe('[From the result of shot (tool call c1):]');
  });

  it('grows the window only when the conversation needs it, the reply counted in', () => {
    const m = { ...thinker, context: 1_000_000, windows: [200_000, 400_000, 1_000_000], defaultWindow: 200_000 };
    expect(windowFor({ messages: [{ role: 'user', content: 'hi' }] }, m, 1000)).toBe(200_000);
    const big = { messages: [{ role: 'user', content: 'x'.repeat(540_000) }] };
    expect(windowFor(big, m, 0)).toBe(200_000);
    expect(windowFor(big, m, 32_000)).toBe(400_000);
    expect(windowFor({ messages: [] }, { ...m, windows: [] }, 0)).toBe(1_000_000);
  });

  it('writes the body: system text, tools, tool_choice and thinking', () => {
    const chat = { reasoning_effort: 'low', max_tokens: 100, tool_choice: 'required', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 't', parameters: { type: 'object' } } }, { type: 'other' }] };
    const b = qoderBody(chat, thinker);
    expect(b.system[0].text).toMatch(/^You are a Qoder agent\..*\n\nBe brief\.\nYou must call an available function in this response\.$/s);
    expect(b.parameters).toEqual({ enable_thinking: true, max_tokens: 100, reasoning_effort: 'low', context_length: 180_000 });
    expect(b.tools).toEqual([{ type: 'function', function: { name: 't', description: '', parameters: { type: 'object' } } }]);
    expect(qoderBody({ ...chat, tool_choice: 'none' }, thinker).tools).toBeUndefined();
    expect(qoderBody({ messages: [] }, thinker).parameters.max_tokens).toBe(32000);
  });
});

describe('failures', () => {
  it('reads queue, quota, refused request, lapsed sign-in and plain statuses', () => {
    const q = failure(403, JSON.stringify({ code: 10605, message: 'queued', queue: { isQueued: true, retryAfterSeconds: 7.2, modelKey: 'perf', queueType: 'free' } }));
    expect(q).toEqual({ status: 503, message: "Qoder queued the request for perf (this plan's queue: free); try again in 8s", retryAfter: 8 });
    expect(failure(500, JSON.stringify({ message: '{"serviceAvailable":false}' })).retryAfter).toBe(30);
    expect(failure(403, JSON.stringify({ code: 112, message: 'out' }))).toEqual({ status: 429, message: 'usage limit reached: out' });
    expect(failure(500, JSON.stringify({ code: '406', message: 'no' })).status).toBe(400);
    expect(failure(401, JSON.stringify({ message: 'token bad' }))).toEqual({ status: 401, message: 'the sign-in lapsed — sign in again (Qoder said 401: token bad)' });
    expect(failure(500, 'your quota is gone').status).toBe(429);
    expect(failure(200, '')).toEqual({ status: 502, message: 'Bad Gateway' });
    expect(failure(418, JSON.stringify({ details: { error: { message: 'inner' } }, message: 'm' })).message).toBe('m: inner');
  });
});

describe('tool calls in text', () => {
  it('are lifted out, whole or in pieces', () => {
    expect(parseCall('{"name":" f ","arguments":{"a":1}}')).toEqual({ name: 'f', args: '{"a":1}' });
    expect(parseCall('<function=g><parameter=n>3</parameter><parameter=s>hi</parameter></function>')).toEqual({ name: 'g', args: '{"n":3,"s":"hi"}' });
    expect(parseCall('nonsense')).toBe(null);
    const s = new Splitter();
    const out = [...s.feed('before <tool_'), ...s.feed('call>{"name":"f","arguments":{}}</tool'), ...s.feed('_call> after'), ...s.flush()];
    expect(out).toEqual([{ text: 'before ' }, { call: { name: 'f', args: '{}' } }, { text: ' after' }]);
    expect(s.sawTool).toBe(true);
    const bad = new Splitter();
    expect(bad.feed('<tool_call>junk</tool_call>')).toEqual([{ text: '<tool_call>junk</tool_call>' }]);
  });
});

describe('prepare', () => {
  it("writes a chat completion as Qoder's request, signed over the bytes the host will send", async () => {
    const { out, calls } = await call('prepare', chatReq(), secretOf(), (r) => (r.url.includes('/model/list') ? json(listing) : json({})));
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/algo/api/v2/model/list']);
    expect(out.url).toBe('https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common');
    expect(out.method).toBe('POST');
    expect(out.headers).toMatchObject({ 'X-Model-Key': 'perf', 'X-Model-Source': 'qoder', Accept: 'text/event-stream', 'Cosy-MachineId': 'm1', 'Cosy-User': 'u1' });
    expect(out.body.model_config.key).toBe('perf');
    expect(out.body.session_type).toBe('app');
    expect(out.body.messages.at(-1).content[0].text).toBe('ping');
    const m = /^Bearer COSY\.([^.]+)\.([0-9a-f]{32})$/.exec(out.headers.Authorization);
    const wire = hostJson(out.body);
    expect(createHash('md5').update(`${m[1]}\n${out.headers['Cosy-Key']}\n${out.headers['Cosy-Date']}\n${wire}\n/api/v2/service/pro/sse/agent_chat_generation`).digest('hex')).toBe(m[2]);
  });

  it('asks the list again for a model it does not know, then refuses it', async () => {
    const n = net(() => json(listing));
    await expect(runProvider(plugin, 'qoder', 'prepare', chatReq({ model: 'nope' }), { ...account, secret: secretOf({ uid: 'u-nope' }) }, n.opts)).rejects.toThrow(/unknown or disabled model "nope"/);
    expect(n.calls).toHaveLength(2);
  });

  it('refuses what is not a chat completion or not JSON, and a missing account', async () => {
    await expect(call('prepare', chatReq({ protocol: 'anthropic' }), secretOf())).rejects.toThrow(/chat completions only/);
    await expect(call('prepare', chatReq({ body: null }), secretOf())).rejects.toThrow(/isn't JSON/);
    await expect(call('prepare', chatReq(), undefined)).rejects.toThrow(/not there/);
  });

  it('renews a near-expired job token before the request and saves the pair', async () => {
    const { out, calls } = await call('prepare', chatReq(), secretOf({ expires: Date.now() + 1000 }), (r) =>
      r.url.includes('jobToken/refresh') ? json({ token: 'job2', refresh_token: 'r2', expires_in: 3600e3 }) : json(listing));
    expect(calls[0].url).toBe('https://openapi.qoder.sh/api/v1/jobToken/refresh');
    expect(JSON.parse(calls[0].body)).toEqual({ refresh_token: 'r1' });
    const saved = JSON.parse(host().accounts.get('qoder').get('a@b.c').secret);
    expect([saved.access, saved.refresh, saved.uid]).toEqual(['job2', 'r2', 'u1']);
    expect(out.headers['Cosy-User']).toBe('u1');
  });

  it("serves Qoder CN on its own hosts, chatting on the device token when that is the chat token", async () => {
    const { out, calls } = await call('prepare', chatReq({ provider: 'qoder-cn' }), secretOf({ deviceChat: true, expires: Date.now() + 1000 }), (r) =>
      r.url.includes('deviceToken/refresh') ? json({ token: 'dt2', refresh_token: 'dr2', expires_in: 100 }) : json(listing), 'qoder-cn');
    expect(calls[0].url).toBe('https://openapi.qoder.com.cn/api/v1/deviceToken/refresh');
    expect(out.url.startsWith('https://gateway.qoder.com.cn/algo/')).toBe(true);
    const saved = JSON.parse(host().accounts.get('qoder-cn').get('a@b.c').secret);
    expect([saved.access, saved.deviceToken, saved.deviceRefresh]).toEqual(['dt2', 'dt2', 'dr2']);
  });
});

describe('models, refresh', () => {
  it("lists the account's own models, else the built-in list", async () => {
    const { out } = await call('models', null, secretOf(), () => json(listing));
    expect(out).toEqual([{ id: 'perf', name: 'Performance', protocol: 'chat', context: 180_000, vision: false, reasoning: false }].map((m) => ({ ...m, vision: true })));
    const builtin = (await call('models', null, undefined)).out;
    expect(builtin.map((m) => m.id)).toContain('ultimate');
    const failed = (await call('models', null, secretOf(), () => json({}, 500))).out;
    expect(failed).toEqual(builtin);
    const cn = (await call('models', null, undefined, undefined, 'qoder-cn')).out;
    expect(cn.map((m) => m.id)).toEqual(['ultimate', 'performance', 'efficient', 'lite']);
  });

  it('refresh renews, and says expired only when Qoder refused the refresh token', async () => {
    const ok = await call('refresh', null, secretOf(), () => json({ token: 'j2', refresh_token: 'r2', expires_in: 3600e3 }));
    expect(ok.out).toBe('renewed');
    const refused = await call('refresh', null, secretOf(), () => json({}, 401));
    expect(refused.out).toBe('expired');
    const hiccup = await call('refresh', null, secretOf(), () => json({}, 500));
    expect(hiccup.out == null).toBe(true);
  });
});

// ---- the reply: fixtures in the shape Qoder's SSE envelopes have ({ statusCodeValue, body: "<OpenAI chunk as a string>" })
const env = (b, status = 200) => ({ data: JSON.stringify({ statusCodeValue: status, body: typeof b === 'string' ? b : JSON.stringify(b) }) });
const delta = (d, extra = {}) => ({ choices: [{ delta: d, ...extra }] });
const reply = (frames, request = {}, extra = {}) => runResponse(plugin, 'qoder', { framing: 'sse', frames, request: { model: 'perf', ...request }, ...extra });
const toolReply = [
  env(delta({ reasoning_content: 'hm' })),
  env(delta({ content: 'hello <tool_call>{"name":"f","arguments":{"a":1}}</tool_call>' })),
  env(delta({ tool_calls: [{ index: 0, id: 'n1', function: { name: 'g', arguments: '{"b"' } }] })),
  env(delta({ tool_calls: [{ index: 0, function: { arguments: ':2}' } }] })),
  env(delta({}, { finish_reason: 'stop' })),
  env({ usage: { prompt_tokens: 5, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } } }),
  env('[DONE]'),
];

describe('reply', () => {
  it('streams text, reasoning, tool calls, the finish and a usage chunk of its own as chat chunks', async () => {
    const r = await reply(toolReply);
    expect(r.failure).toBe(null);
    const deltas = r.frames.map((c) => c.choices[0].delta);
    expect(deltas[0]).toEqual({ role: 'assistant', content: '' });
    expect(deltas[1]).toEqual({ reasoning_content: 'hm' });
    expect(deltas[2]).toEqual({ content: 'hello ' });
    expect(deltas[3].tool_calls[0]).toMatchObject({ index: 0, type: 'function', function: { name: 'f', arguments: '{"a":1}' } });
    expect(deltas[3].tool_calls[0].id).toMatch(/^call_[0-9a-f]{32}$/);
    expect(deltas[4]).toEqual({ tool_calls: [{ index: 1, id: 'n1', type: 'function', function: { name: 'g', arguments: '{"b"' } }] });
    expect(deltas[5]).toEqual({ tool_calls: [{ index: 1, function: { arguments: ':2}' } }] });
    const last = r.frames.at(-1);
    expect(last.choices[0].finish_reason).toBe('tool_calls');
    expect(last.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } });
    expect(new Set(r.frames.map((c) => c.id)).size).toBe(1);
    expect(r.frames.every((c) => c.object === 'chat.completion.chunk' && c.model === 'perf')).toBe(true);
  });

  it('gathers a whole completion for a non-streaming request', async () => {
    const r = await reply(
      [env(delta({ content: 'hi' })), env(delta({ tool_calls: [{ index: 0, id: 'n1', function: { name: 'g', arguments: '{' } }] })), env(delta({ tool_calls: [{ index: 0, function: { arguments: '}' } }] })),
        env(delta({}, { finish_reason: 'stop' })), env({ usage: { prompt_tokens: 1, completion_tokens: 2 } })],
      { stream: false },
    );
    expect(r.failure).toBe(null);
    expect(r.body).toMatchObject({ object: 'chat.completion', model: 'perf' });
    expect(r.body.choices[0].finish_reason).toBe('tool_calls');
    expect(r.body.choices[0].message).toEqual({ role: 'assistant', content: 'hi', tool_calls: [{ id: 'n1', type: 'function', function: { name: 'g', arguments: '{}' } }] });
    expect(r.body.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });

  it('ends a stream with the finish; length stays length; an empty reply is an empty completion', async () => {
    const r = await reply([env(delta({ content: 'a' })), env(delta({}, { finish_reason: 'length' }))]);
    expect(r.frames.map((c) => c.choices[0].delta)).toEqual([{ role: 'assistant', content: '' }, { content: 'a' }, {}]);
    expect(r.frames.at(-1).choices[0].finish_reason).toBe('length');
    const empty = await reply([], { stream: false });
    expect(empty.body.choices[0]).toEqual({ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' });
  });

  it('keeps text held back for a tool-call tag that never came', async () => {
    const r = await reply([env(delta({ content: 'a <tool_' })), env(delta({}, { finish_reason: 'stop' }))]);
    expect(r.frames.map((c) => c.choices[0].delta.content).filter(Boolean)).toEqual(['a ', '<tool_']);
  });

  it("makes an error envelope the failure's status and Qoder's words", async () => {
    const r = await reply([env('slow down', 429)]);
    expect(r.failure).toEqual({ status: 429, message: 'usage limit reached: slow down' });
    expect(r.frames).toEqual([]);
    const q = await reply([env(JSON.stringify({ code: 10605, message: 'queued', queue: { isQueued: true, retryAfterSeconds: 4 } }), 403)], { stream: false });
    expect(q.failure.status).toBe(503);
    const bad = await reply([env('bad', 400)]);
    expect(bad.failure).toEqual({ status: 400, message: 'bad' });
  });

  it('ignores what follows [DONE] and lines that are not envelopes', async () => {
    const r = await reply([{ data: 'not json' }, env(delta({ content: 'a' })), env('[DONE]'), env(delta({ content: 'late' }))]);
    expect(r.frames.map((c) => c.choices[0].delta.content).filter(Boolean)).toEqual(['a']);
  });

  it("maps a refused upstream reply by Qoder's codes, and leaves a lapsed sign-in to the host's refresh", async () => {
    const start = (status, body) => runResponse(plugin, 'qoder', { framing: 'sse', frames: [], response: { status, body } });
    expect((await start(403, JSON.stringify({ code: 112, message: 'out' }))).error).toEqual({ status: 429, message: 'usage limit reached: out' });
    expect((await start(403, JSON.stringify({ code: 10605, queue: { isQueued: true } }))).error.status).toBe(503);
    expect((await start(500, JSON.stringify({ code: '406', message: 'no' }))).error.status).toBe(400);
    expect((await start(401, JSON.stringify({ message: 'x' }))).error).toBe(null);
    expect((await start(403, '')).error).toBe(null);
  });
});

describe('sign-in', () => {
  const open = (view, fetch) => mount(view, { permissions: PERMS, fetch });
  const answers = (extra = {}) => async (req) => {
    if (req.url.includes('deviceToken/poll')) return json(extra.poll ?? { token: 'dt', refresh_token: 'dr', user_id: 'u9', user_name: 'N' });
    if (req.url.includes('me/jobToken')) return extra.job ?? json({ token: 'jt', refresh_token: 'jr', expires_in: 1000 });
    if (req.url.includes('userinfo')) return json({ email: 'e@x.y', name: 'Name' });
    throw new Error(req.url);
  };

  it("the challenge is the S256 of the verifier (RFC 7636's vector)", () => {
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('opens the site page, polls, trades for a job token and adds the account', async () => {
    const view = await open(signIn, answers());
    expect(view.find('Button').props.label).toBe('signIn.start');
    const effects = await view.press('start');
    const url = new URL(effects.find((e) => e.type === 'openExternal').url);
    expect(url.origin + url.pathname).toBe('https://qoder.com/device/selectAccounts');
    expect(url.searchParams.get('challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('qoder-app://');
    expect(url.searchParams.get('client_id')).toBe(SITES.qoder.clientId);
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const a = host().accounts.get('qoder').get('e@x.y');
    expect(a).toMatchObject({ displayName: 'e@x.y', email: 'e@x.y', status: 'active' });
    expect(JSON.parse(a.secret)).toMatchObject({ access: 'jt', refresh: 'jr', uid: 'u9', email: 'e@x.y', name: 'Name', deviceToken: 'dt', deviceRefresh: 'dr' });
    expect(JSON.parse(a.secret).machineId).toBe(url.searchParams.get('machine_id'));
    expect(JSON.parse(a.secret).deviceChat).toBeUndefined();
  });

  it('on Qoder CN, a refused job token falls back to chatting on the device token', async () => {
    const view = await open(signInCn, answers({ poll: { token: 'dt', refresh_token: 'dr', user_id: 'u9', expires_in: 100 }, job: json({}, 403) }));
    const effects = await view.press('start');
    expect(new URL(effects.find((e) => e.type === 'openExternal').url).origin).toBe('https://qoder.cn');
    expect(new URL(effects.find((e) => e.type === 'openExternal').url).searchParams.has('redirect_uri')).toBe(false);
    const s = JSON.parse(host().accounts.get('qoder-cn').get('e@x.y').secret);
    expect([s.access, s.refresh, s.deviceChat]).toEqual(['dt', 'dr', true]);
    expect(s.expires).toBeGreaterThan(Date.now() + 99_000);
  });

  it('polls in slices: a slice that ends unconfirmed leaves the code good, a timed-out code is an error', async () => {
    const site = SITES.qoder;
    const d = { nonce: 'n', verifier: 'v', until: Date.now() + 60_000 };
    host().granted = new Set(PERMS);
    let polls = 0;
    host().fetch = async () => (++polls < 3 ? json({}, 404) : json({ token: 'dt', refresh_token: 'dr', user_id: 'u9' }));
    const sleeps = [];
    const sleep = async (ms) => void sleeps.push(ms);
    expect(await pollDeviceToken(site, d, 1000, sleep)).toBe(null); // no room for another try: nothing asked
    expect(polls).toBe(0);
    expect(await pollDeviceToken(site, d, Infinity, sleep)).toMatchObject({ token: 'dt', user_id: 'u9' });
    expect(sleeps).toEqual([2000, 2000]);
    await expect(pollDeviceToken(site, { ...d, until: Date.now() - 1 }, Infinity, sleep)).rejects.toThrow(/timed out/);
  });

  it('shows an error on screen when the sign-in cannot finish, and adds nothing', async () => {
    const view = await open(signIn, answers({ job: json({}, 500) }));
    await view.press('start');
    expect(view.find('Alert').props.message).toMatch(/job token: status 500/);
    expect(host().accounts.get('qoder')?.size ?? 0).toBe(0);
  });
});
