import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin from '../src/main.js';
import { SITES } from '../src/sites.js';

const cn = SITES['trae-cn'];
const global = SITES['trae-global'];
const messages = { en: JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')), zh: JSON.parse(readFileSync(new URL('../locales/zh.json', import.meta.url), 'utf8')) };
const manifest = JSON.parse(readFileSync(new URL('../astra.plugin.json', import.meta.url), 'utf8'));
const PERMS = manifest.permissions;

const NOW = Date.now();
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = 'h.' + b64url({ exp: Math.floor(NOW / 1000) + 3600 }) + '.s';
const stored = JSON.stringify({ token: jwt, refresh: 'R1', expires: NOW + 3600_000, uid: 'u1', name: 'alice', clientId: 'ono9krqynydwx5', deviceId: '1234567890123456789', machineId: 'abcd' });
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });
const entry = (id, o = {}) => ({ config_name: id, display_name: id.toUpperCase(), model_detail_list: [{ model_name: id + '__dev', max_tokens: 8000 }], context_window_tokens: { dev: 100_000 }, ...o });

const opts = (extra = {}) => ({ permissions: PERMS, messages, secrets: { 'auth:trae-cn:u1': stored, 'auth:trae-global:u1': stored }, ...extra });
const prepare = (site, body, extra = {}) =>
  runProvider(plugin, site.id, 'prepare', { protocol: 'chat', model: body.model, path: '/v1/chat/completions', method: 'POST', headers: {}, body, stream: body.stream !== false }, { key: 'u1', secret: 'u1' }, opts(extra));
const respond = (site, frames, request = {}, extra = {}) => runResponse(plugin, site.id, { framing: 'sse', frames, request: { model: 'glm-5', stream: true, ...request }, account: { key: 'u1', secret: 'u1' } }, opts(extra));

// Trae's SSE events as the host cuts them: { event, data (the text), json }
const ev = (event, data) => ({ event, data: JSON.stringify(data), json: data });

describe('prepare', () => {
  it('shapes the request for the IDE agent, as the account', async () => {
    const calls = [];
    const r = await prepare(cn, { model: 'glm-5', stream: true, max_tokens: 5000, messages: [{ role: 'user', content: 'hello' }] }, { fetch: async (url) => (calls.push(url), json({ function_configs: [{ function: 'chat_v3', config_info_list: [entry('glm-5')] }] })) });
    expect(calls).toEqual([]); // the model is not a Max one: no list is read for it
    expect(r.url).toBe('https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat');
    expect(r.headers.Authorization).toBe('Cloud-IDE-JWT ' + jwt);
    expect(r.headers.Accept).toBe('text/event-stream');
    expect(r.headers['x-device-id']).toBe('1234567890123456789');
    expect(r.body).toMatchObject({ function: 'chat_v3', config_name: 'glm-5', model: 'glm-5', stream: true, max_tokens: 5000 });
    expect(r.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
    expect(r.body.session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps one conversation under one session id, and tells accounts apart', async () => {
    const a = await prepare(cn, { model: 'glm-5', messages: [{ role: 'user', content: 'first' }] });
    const b = await prepare(cn, { model: 'glm-5', messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'again' }] });
    expect(a.body.session_id).toBe(b.body.session_id);
    expect(a.body.request_id).not.toBe(b.body.request_id);
  });

  it('asks the function that lists the model, and the model\'s own __dev name, once the list was read', async () => {
    const fetch = async () => json({ function_configs: [{ function: 'chat_v3', config_info_list: [entry('a')] }, { function: 'solo_agent', config_info_list: [entry('solo-only')] }] });
    await runProvider(plugin, 'trae-cn', 'models', null, { key: 'u1', secret: 'u1' }, opts({ fetch }));
    const r = await prepare(cn, { model: 'solo-only', messages: [{ role: 'user', content: 'x' }] });
    expect(r.body).toMatchObject({ function: 'solo_agent', model_name: 'solo-only__dev', config_name: 'solo-only' });
  });

  it('reads the list for a Max model asked before it, and asks its base with the window', async () => {
    const fetch = async () => json({ function_configs: [{ function: 'chat_v3', config_info_list: [entry('big', { model_detail_list: [{ model_name: 'big__dev', max_tokens: 8000 }, { model_name: 'big__max', max_tokens: 64000 }], context_window_tokens: { dev: 100_000, max: 500_000 } })] }] });
    const r = await prepare(cn, { model: 'big-max', messages: [{ role: 'user', content: 'x' }] }, { fetch });
    expect(r.body).toMatchObject({ config_name: 'big', model_name: 'big__max', max_tokens: 64000, user_message_context: { model_info: { prompt_max_tokens: 436000 } } });
  });

  it('puts the tools in natively and in the system prompt', async () => {
    const tools = [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];
    const r = await prepare(global, { model: 'gpt-5.4', tools, messages: [{ role: 'user', content: 'ls' }] });
    expect(r.url).toBe('https://coresg-normal.trae.ai/api/agent/v3/llm_utils_chat');
    expect(r.body.tools[0].function.name).toBe('bash');
    expect(r.body.messages[0].role).toBe('system');
    expect(r.body.messages[0].content[0].text).toContain('<tool_call>');
  });

  it('refuses a body that is not a chat, and an account that is not signed in', async () => {
    await expect(prepare(cn, { model: 'glm-5' })).rejects.toThrow(/serves chat completions only/);
    await expect(prepare(cn, { model: 'glm-5', messages: [] }, { secrets: {} })).rejects.toThrow(/not signed in/);
  });
});

describe('reply: a stream', () => {
  const answer = [
    ev('queue', { position: 2 }),
    ev('output', { response: 'Building prompt: x' }),
    ev('output', { response: 'Hello ', reasoning_content: 'hm' }),
    ev('output', { delta: { content: 'world' } }),
    ev('token_usage', { usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    ev('done', { finish_reason: 'length' }),
  ];

  it('turns Trae\'s events into chat chunks: role, reasoning, text, finish, usage', async () => {
    const r = await respond(cn, answer);
    expect(r.failure).toBeNull();
    const chunks = r.frames;
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks.map((c) => c.choices[0]?.delta)).toEqual([{ role: 'assistant', content: '' }, { reasoning_content: 'hm' }, { content: 'Hello ' }, { content: 'world' }, {}, undefined]);
    expect(chunks.at(-2).choices[0].finish_reason).toBe('length');
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    expect(chunks[0]).toMatchObject({ object: 'chat.completion.chunk', model: 'glm-5' });
  });

  it('streams a call written as text and a native one, named as the request names the tool', async () => {
    const tools = [{ type: 'function', function: { name: 'read', parameters: { properties: { path: {} } } } }];
    await prepare(cn, { model: 'glm-5', tools, messages: [{ role: 'user', content: 'x' }] });
    const r = await respond(cn, [
      ev('output', { content: 'Reading. <tool_call>{"name":"Read","arguments":{"arguments":{"path":"a"}}}</tool_call>' }),
      ev('output', { tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"b"}' } }] }),
      ev('done', {}),
    ]);
    const calls = r.frames.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    expect(calls.map((c) => [c.index, c.function.name, c.function.arguments])).toEqual([[0, 'read', '{"path":"a"}'], [1, 'read', '{"path":"b"}']]);
    expect(calls[1].id).toBe('c1');
    expect(r.frames.map((c) => c.choices[0]?.delta?.content).filter(Boolean).join('')).toBe('Reading. ');
    expect(r.frames.at(-1).choices[0].finish_reason).toBe('tool_calls');
  });

  it('a first event that is an error is the reply\'s status, before any chunk', async () => {
    const quota = await respond(cn, [ev('error', { code: 4008, message: 'credits used up' })]);
    expect(quota.frames).toEqual([]);
    expect(quota.failure).toEqual({ status: 429, message: 'Trae CN: credits used up' });
    const out = await respond(cn, [ev('error', { code: 1001, message: 'not logged in' })]);
    expect(out.failure.status).toBe(401);
    expect(out.failure.message).toMatch(/sign-in has expired/);
    const bare = await respond(global, [ev('message', { code: 20101, message: 'bad token' })]);
    expect(bare.failure.status).toBe(401);
    const other = await respond(global, [ev('error', { code: 7, message: 'boom' })]);
    expect(other.failure).toEqual({ status: 502, message: 'Trae Global: boom (code 7)' });
  });

  it('a call cut short ends the answer with an error, never as the answer', async () => {
    const r = await respond(cn, [ev('output', { content: 'ok <tool_call>{"name":"bash","argu' }), ev('done', {})]);
    expect(r.failure.status).toBe(502);
    expect(r.failure.message).toMatch(/cut short/);
  });

  it('answers with nothing at all as a failure (an error in a 200 is not a frame)', async () => {
    const r = await respond(cn, []);
    expect(r.failure).toEqual({ status: 502, message: 'Trae CN: Trae sent no answer' });
  });

  it('an answer that ends without a done event still finishes', async () => {
    const r = await respond(cn, [ev('output', { response: 'hi' })]);
    expect(r.frames.at(-1).choices[0].finish_reason).toBe('stop');
  });
});

describe('reply: a body', () => {
  it('gathers the stream into one chat.completion with reasoning, calls, usage and finish', async () => {
    const r = await respond(cn, [
      ev('output', { reasoning_content: 'r', response: 'hi' }),
      ev('token_usage', { usage: { prompt_tokens: 1, completion_tokens: 2 } }),
      ev('done', { finish_reason: 'length' }),
    ], { stream: false });
    expect(r.failure).toBeNull();
    expect(r.body.object).toBe('chat.completion');
    expect(r.body.choices[0].message).toEqual({ role: 'assistant', content: 'hi', reasoning_content: 'r' });
    expect(r.body.choices[0].finish_reason).toBe('length');
    expect(r.body.usage.total_tokens).toBe(3);
    const calls = await respond(cn, [ev('output', { tool_calls: [{ id: 'c', function: { name: 'bash', arguments: '{}' } }] }), ev('done', {})], { stream: false });
    expect(calls.body.choices[0].message.content).toBeNull();
    expect(calls.body.choices[0].message.tool_calls[0].function.name).toBe('bash');
    expect(calls.body.choices[0].finish_reason).toBe('tool_calls');
  });

  it('an error in a body is its failure', async () => {
    const r = await respond(cn, [ev('error', { code: 4008, message: 'no quota' })], { stream: false });
    expect(r.failure.status).toBe(429);
  });
});

describe('reply: a refused request', () => {
  const refused = (status, body, site = cn) => runResponse(plugin, site.id, { framing: 'sse', frames: [], response: { status, body: JSON.stringify(body) }, request: { model: 'glm-5', stream: true }, account: { key: 'u1', secret: 'u1' } }, opts());

  it('maps what Trae answered: expired sign-in 401, spent allowance 429, the rest as it came', async () => {
    expect((await refused(401, { code: 1001, message: 'x' })).error).toMatchObject({ status: 401 });
    expect((await refused(403, { message: 'JWT token expired' })).error).toMatchObject({ status: 401 });
    expect((await refused(403, { message: 'quota exceeded' })).error).toMatchObject({ status: 429 });
    expect((await refused(500, { code: 9, message: 'oops' })).error).toEqual({ status: 500, message: 'Trae CN: oops (code 9)' });
  });

  it('a function that does not take the model is left for another on the next request', async () => {
    const fetch = async () => json({ function_configs: [{ function: 'chat_v3', config_info_list: [entry('m1')] }, { function: 'solo_agent', config_info_list: [entry('m1')] }] });
    await runProvider(plugin, 'trae-cn', 'models', null, { key: 'u1', secret: 'u1' }, opts({ fetch }));
    const first = await prepare(cn, { model: 'm1', messages: [{ role: 'user', content: 'x' }] });
    const fn = first.body.function;
    const r = await runResponse(plugin, 'trae-cn', { framing: 'sse', frames: [], response: { status: 400, body: JSON.stringify({ code: 4001, message: 'no such model' }) }, request: { model: 'm1', stream: true }, account: { key: 'u1', secret: 'u1' } }, opts());
    expect(r.error.status).toBe(400);
    const second = await prepare(cn, { model: 'm1', messages: [{ role: 'user', content: 'x' }] });
    expect(second.body.function).not.toBe(fn);
  });
});
