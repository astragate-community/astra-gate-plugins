import { describe, expect, it } from 'vitest';
import { mount, runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin, { signIn } from '../src/main.js';
import { buildModels, bootstrapProvider, isFree, parseProtocolDocs } from '../src/models.js';
import { sessionID, withCoreTools } from '../src/request.js';
import { forget } from '../src/reply.js';

const PERMS = ['providers', 'storage', 'ui', 'net:https://opencode.ai', 'net:https://models.opencode.ai', 'net:https://raw.githubusercontent.com'];
const json = (body) => ({ status: 200, headers: { 'content-type': 'application/json' }, body });

describe('model selection', () => {
  it('knows free and retired models', () => {
    expect(isFree('big-pickle', { cost: { input: 0, output: 0 } })).toBe(true);
    expect(isFree('x-free')).toBe(true);
    expect(isFree('paid', { cost: { input: 1, output: 2 } })).toBe(false);
    expect(isFree('x-free', { status: 'retired' })).toBe(false);
    expect(isFree('x-free', { deprecated: true })).toBe(false);
  });

  it('reads each model protocol from the docs table', () => {
    const docs = '| Big Pickle | big-pickle | `https://opencode.ai/zen/v1/chat/completions` |\n| S | `muse` | `https://opencode.ai/zen/v1/responses` |';
    expect(parseProtocolDocs(docs)).toEqual({ 'big-pickle': 'chat', muse: 'responses' });
  });

  it('keeps free models of a known protocol, with limits and capabilities', () => {
    const models = buildModels([...Object.keys(bootstrapProvider.models), '__proto__', 'nope'], bootstrapProvider, {});
    expect(models.map((m) => m.id)).toEqual(['big-pickle', 'space-bunny-free', 'muse-spark-1.3-contributor-free']);
    expect(models[2]).toMatchObject({ protocol: 'responses', vision: true, context: 1048576, output: 131072 });
    expect(models[0]).toMatchObject({ protocol: 'chat', vision: false, context: 200000, reasoning: true });
  });
});

describe('request shaping', () => {
  it('stubs the core tools the agent did not declare, without touching the original', () => {
    const body = { tools: [{ type: 'function', function: { name: 'bash' } }] };
    const next = withCoreTools(body, 'chat');
    expect(body.tools).toHaveLength(1);
    expect(next.tools.map((t) => t.function.name)).toEqual(['bash', 'edit', 'glob', 'grep', 'read']);
    expect(next.tools[1].function.parameters.additionalProperties).toBe(false);
    expect(withCoreTools({}, 'anthropic').tools[0].input_schema).toBeTruthy();
    expect(withCoreTools({}, 'responses').tools[0]).toMatchObject({ type: 'function', name: 'bash' });
  });

  it('gives a conversation one stable ses_ id', () => {
    const a = sessionID({}, { messages: [{ role: 'user', content: 'hi' }] });
    expect(a).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(sessionID({ 'x-session-id': 'abc' }, {})).toBe(sessionID({ 'x-opencode-session': 'abc' }, {}));
    expect(sessionID({}, { messages: [{ role: 'user', content: 'hi' }] })).toBe(a);
    expect(sessionID({ 'x-session-id': a }, {})).toBe(a);
  });
});

describe('provider', () => {
  const req = (protocol, extra = {}) => ({ protocol, model: 'big-pickle', path: '/v1/x', method: 'POST', headers: { 'x-session-id': 'abc' }, body: { model: 'big-pickle', stream: true }, stream: true, ...extra });
  const prepare = (r) => runProvider(plugin, 'opencode-zen-free', 'prepare', r, { key: 'public', secret: 'public' }, { permissions: PERMS });

  it('prepares each native protocol with the public credential', async () => {
    const chat = await prepare(req('chat'));
    expect(chat.url).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(chat.headers.authorization).toBe('Bearer public');
    expect(chat.headers['x-opencode-client']).toBe('cli');
    expect(chat.headers['x-session-affinity']).toMatch(/^ses_/);
    expect(chat.body.stream).toBe(true);
    expect(chat.body.stream_options).toEqual({ include_usage: true });
    expect((await prepare(req('responses'))).url).toBe('https://opencode.ai/zen/v1/responses');
    const anthropic = await prepare(req('anthropic'));
    expect(anthropic.url).toBe('https://opencode.ai/zen/v1/messages');
    expect(anthropic.headers['x-api-key']).toBe('public');
    expect(anthropic.headers['anthropic-version']).toBe('2023-06-01');
    expect(anthropic.headers.authorization).toBeUndefined();
  });

  it('refuses a protocol Zen does not speak', async () => {
    await expect(prepare(req('gemini'))).rejects.toThrow(/gemini/);
  });

  const zen = (listing, { catalog, docs } = {}) => ({
    permissions: PERMS,
    fetch: async ({ url }) => {
      if (url.endsWith('/zen/v1/models')) return listing ? json(listing) : { status: 500, body: {} };
      if (url.includes('models.opencode.ai')) return catalog ? json(catalog) : { status: 500, body: {} };
      return docs ? { status: 200, body: docs } : { status: 500, body: '' };
    },
  });
  const models = (opts, storage) => runProvider(plugin, 'opencode-zen-free', 'models', null, null, { ...opts, storage });

  it('discovers the free models Zen lists now', async () => {
    const docs = '| A | new-free | `https://opencode.ai/zen/v1/messages` |';
    const catalog = { opencode: { npm: '@ai-sdk/openai-compatible', models: { 'new-free': { name: 'New Free', limit: { context: 1000, output: 100 } } } } };
    const got = await models(zen({ data: [{ id: 'new-free' }, { id: 'paid', }] }, { catalog, docs }));
    expect(got).toEqual([{ id: 'new-free', name: 'New Free', protocol: 'anthropic', context: 1000, output: 100, vision: false, reasoning: false }]);
  });

  it('falls back to the last good list, then to the bootstrap, when the listing fails', async () => {
    const last = [{ id: 'old-free', protocol: 'chat' }];
    expect(await models(zen(null), { models: last })).toEqual(last);
    expect((await models(zen(null))).map((m) => m.id)).toContain('big-pickle');
  });
});

describe('sign-in flow', () => {
  it('adds the public account and closes', async () => {
    const view = await mount(signIn, { permissions: PERMS });
    expect(view.find('Button').props.label).toBe('signIn.enable');
    const effects = await view.press('enable');
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const again = await view.press('enable'); // pressing twice does not add a second account
    expect([...globalThis.__astraTestHost.accounts.get("opencode-zen-free").keys()]).toEqual(["public"]);
    expect(again.some((e) => e.type === 'close')).toBe(true);
  });
});

// ---- the reply: tool guard, collapse, protocol-shaped events (frames as the host cuts them from Zen's SSE)
const sse = (...events) => events.map((e) => (typeof e === 'string' ? { data: e } : { data: JSON.stringify(e), json: e, ...(e.type ? { event: e.type } : {}) }));
const request = (protocol, body, stream = true) => ({ protocol, model: 'big-pickle', path: '/v1/x', method: 'POST', headers: {}, body: { model: 'big-pickle', stream, ...body }, stream });
const reply = async (protocol, body, frames, stream = true) => {
  forget();
  await runProvider(plugin, 'opencode-zen-free', 'prepare', request(protocol, body, stream), { key: 'public', secret: 'public' }, { permissions: PERMS });
  return runResponse(plugin, 'opencode-zen-free', { frames, request: { protocol, model: 'big-pickle', stream } });
};
const readTool = { type: 'function', function: { name: 'Read', parameters: {} } };
const chunk = (delta, finish = null, extra = {}) => ({ id: 'c1', object: 'chat.completion.chunk', model: 'big-pickle', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });

describe('reply', () => {
  it('passes a chat stream through and ends it with [DONE]', async () => {
    const out = await reply('chat', {}, sse(chunk({ content: 'hel' }), chunk({ content: 'lo' }, 'stop'), '[DONE]'));
    expect(out.failure).toBeNull();
    expect(out.frames.map((f) => f.choices?.[0]?.delta?.content ?? f)).toEqual(['hel', 'lo', '[DONE]']);
  });

  it('holds a chat tool call until its choice finishes, then releases it renamed to the declared tool', async () => {
    const out = await reply(
      'chat',
      { tools: [{ type: 'function', function: { name: 'todo_write' } }] },
      sse(
        chunk({ tool_calls: [{ index: 0, id: 't', function: { name: 'tod', arguments: '{' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { name: 'owrite', arguments: '}' } }] }, 'tool_calls'),
        '[DONE]',
      ),
    );
    const events = out.frames.filter((f) => typeof f === 'object');
    expect(events).toHaveLength(1);
    expect(events[0].choices[0].delta.tool_calls[0].function).toEqual({ name: 'todo_write', arguments: '{}' });
    expect(out.frames.at(-1)).toBe('[DONE]');
  });

  it('cuts a stream at a call to an undeclared tool, with the protocol error event', async () => {
    const out = await reply('anthropic', { tools: [{ name: 'Read', input_schema: {} }] }, sse(
      { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'rm', input: {} } },
      { type: 'message_stop' },
    ));
    expect(out.frames[0]).toMatchObject({ event: 'message_start' });
    expect(out.frames[1]).toMatchObject({ event: 'error', data: { type: 'error', error: { message: expect.stringContaining('not declared by the client') } } });
    expect(out.frames).toHaveLength(2);
    expect(out.failure).toBeNull();
  });

  it('renames a case variant in a responses stream and writes event pairs', async () => {
    const out = await reply('responses', { tools: [{ type: 'function', name: 'Read' }] }, sse(
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'i', name: 'read', arguments: '' } },
      { type: 'response.completed', response: { id: 'r', status: 'completed', output: [] } },
    ));
    expect(out.frames[0]).toEqual({ event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'i', name: 'Read', arguments: '' } } });
    expect(out.frames[1].event).toBe('response.completed');
  });

  it('collapses a stream into one chat body for a client that wanted JSON', async () => {
    const out = await reply('chat', { tools: [readTool] }, sse(
      chunk({ role: 'assistant', content: 'ok' }),
      chunk({ tool_calls: [{ index: 0, id: 't', function: { name: 'read', arguments: '{"a":1}' } }] }, 'tool_calls', { usage: { total_tokens: 3 } }),
      '[DONE]',
    ), false);
    expect(out.failure).toBeNull();
    expect(out.body).toMatchObject({ object: 'chat.completion', usage: { total_tokens: 3 } });
    expect(out.body.choices[0].message.content).toBe('ok');
    expect(out.body.choices[0].message.tool_calls[0].function).toEqual({ name: 'Read', arguments: '{"a":1}' });
    expect(out.body.choices[0].finish_reason).toBe('tool_calls');
  });

  it('collapses an anthropic stream, parsing the tool input', async () => {
    const out = await reply('anthropic', { tools: [{ name: 'Read', input_schema: {} }] }, sse(
      { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ), false);
    expect(out.body.content[0].input).toEqual({ a: 1 });
    expect(out.body.stop_reason).toBe('tool_use');
  });

  it('fails a collapse without a completion marker, or with an upstream error event, as 502', async () => {
    const cut = await reply('anthropic', {}, sse({ type: 'message_start', message: {} }));
    expect(cut.failure).toEqual({ status: 502, message: 'Upstream SSE ended without a completion marker' });
    const bad = await reply('responses', {}, [{ event: 'error', data: 'boom' }], false);
    expect(bad.failure).toEqual({ status: 502, message: 'boom' });
    expect((await reply('anthropic', {}, sse({ type: 'message_start', message: {} }), false)).body).toBeUndefined();
  });

  it('fails a JSON-wanted chat reply that calls an undeclared tool', async () => {
    const out = await reply('chat', { tools: [readTool] }, sse(chunk({ tool_calls: [{ index: 0, id: 't', function: { name: 'rm', arguments: '{}' } }] }, 'tool_calls'), '[DONE]'), false);
    expect(out.failure.status).toBe(502);
    expect(out.failure.message).toMatch(/not declared/);
  });

  it('passes a refusal through untouched', async () => {
    forget();
    const out = await runResponse(plugin, 'opencode-zen-free', { frames: [], request: { protocol: 'chat', model: 'big-pickle', stream: true }, response: { status: 429, body: '{"error":"slow down"}' } });
    expect(out.error).toBeNull();
    expect(out.status).toBe(429);
  });
});
