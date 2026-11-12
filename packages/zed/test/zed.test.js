import { describe, expect, it } from 'vitest';
import { mount, runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin, { signIn } from '../src/main.js';
import { modelsOff, orgOf, planName, stateOf, who } from '../src/account.js';
import { failure } from '../src/api.js';
import { hostModel, parseModels } from '../src/models.js';
import { usage } from '../src/usage.js';

const PERMS = ['providers', 'ui', 'net:https://cloud.zed.dev'];
const json = (body, status = 200, headers = {}) => ({ status, headers, body });
const SECRET = JSON.stringify({ userId: '7', access: 'acc', systemId: 'sys', org: 'o1', plan: 'zed_pro', who: 'me' });
const run = (what, request, opts = {}, account = { key: '7', secret: SECRET }) => runProvider(plugin, 'zed', what, request, account, { permissions: PERMS, ...opts });

describe('account helpers', () => {
  it('pick the organization, the name, the plan and read the saved secret', () => {
    const me = { default_organization_id: 'b', organizations: [{ id: 'a' }, { id: 'b' }], user: { github_login: ' octo ', name: 'N' } };
    expect(orgOf(me)).toBe('b');
    expect(orgOf({ organizations: [{ id: 'z' }], default_organization_id: 'gone' })).toBe('z');
    expect(who(me)).toBe('octo');
    expect(who({ user: { legacy_user_id: 5 } })).toBe('5');
    expect(who({})).toBe('Zed account');
    expect(planName('zed_pro_trial')).toBe('Pro Trial');
    expect(planName('')).toBe('Free');
    expect(planName('zed_x')).toBe('x');
    expect(modelsOff({ configuration_by_organization: { o: { is_zed_model_provider_enabled: false } } }, 'o')).toBe(true);
    expect(stateOf(SECRET)).toEqual({ access: 'acc', userId: '7', systemId: 'sys', org: 'o1', plan: 'zed_pro', who: 'me' });
    expect(stateOf('nope')).toBeNull();
    expect(stateOf('{}')).toBeNull();
  });

  it("says what Zed said of a refusal, or the status's name", () => {
    expect(failure(400, '{"message":"bad"}')).toBe('bad');
    expect(failure(400, '{"code":"x"}')).toBe('x');
    expect(failure(402, '')).toMatch(/payment required/);
    expect(failure(503, '')).toBe('Service Unavailable');
  });
});

describe('models', () => {
  it('drops disabled and unknown-provider models, and says what the host needs', () => {
    const out = parseModels(
      JSON.stringify({
        models: [
          { id: 'a', provider: 'anthropic' },
          { id: 'b', provider: 'open_ai', is_disabled: true },
          { id: 'c', provider: 'nope' },
          { id: 'g', provider: 'google' },
        ],
      }),
    );
    expect(out.map((m) => m.id)).toEqual(['a', 'g']);
    expect(() => parseModels('{}')).toThrow(/lists no models/);
    expect(hostModel({ id: 'g', provider: 'google', supports_images: true, max_token_count: 10, supported_effort_levels: [{ value: 'low' }] })).toEqual({
      id: 'g',
      name: 'g',
      protocol: 'gemini',
      context: 10,
      output: undefined,
      vision: true,
      reasoning: true,
    });
    expect(hostModel({ id: 'x', provider: 'x_ai', display_name: 'Grok' })).toMatchObject({ protocol: 'chat', name: 'Grok', vision: false, reasoning: false });
  });

  it("come from the account's list, minting the model token first and asking for xAI's", async () => {
    const calls = [];
    const fetch = async (r) => {
      calls.push(r);
      return r.url.endsWith('/client/llm_tokens') ? json({ token: 'mt' }) : json({ models: [{ id: 'claude-x', provider: 'anthropic', display_name: 'X' }] });
    };
    const out = await run('models', null, { fetch }, { key: '99', secret: JSON.stringify({ userId: '99', access: 'a99', org: 'o' }) });
    expect(out).toEqual([{ id: 'claude-x', name: 'X', protocol: 'anthropic', vision: false, reasoning: false }]);
    expect(calls[0].headers.Authorization).toBe('99 a99');
    expect(JSON.parse(calls[0].body)).toEqual({ organization_id: 'o' });
    expect(calls[1].headers.Authorization).toBe('Bearer mt');
    expect(calls[1].headers['x-zed-client-supports-x-ai']).toBe('true');
  });

  it('fall back to the built-in list when Zed cannot answer, and without an account', async () => {
    const down = async () => json('x', 503);
    expect((await run('models', null, { fetch: down }, { key: '98', secret: JSON.stringify({ userId: '98', access: 'a98' }) })).map((m) => m.id)).toContain('claude-sonnet-5');
    expect((await run('models', null, {}, null)).length).toBeGreaterThan(3);
  });
});

describe('model token', () => {
  const S = { userId: '71', access: 'acc71', systemId: 'sys', org: 'o1', who: 'me' };
  it('is minted once per list read, with the pair as Authorization', async () => {
    const calls = [];
    const out = await run(
      'models',
      null,
      {
        fetch: async (r) => {
          calls.push(r);
          return r.url.endsWith('/client/llm_tokens') ? json({ token: 't1' }) : json({ models: [{ id: 'm', provider: 'google' }] });
        },
      },
      { key: '71', secret: JSON.stringify(S) },
    );
    expect(out[0].id).toBe('m');
    expect(calls.filter((c) => c.url.endsWith('llm_tokens'))).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('71 acc71');
  });

  it('is minted again, once, when /models calls it stale', async () => {
    const tokens = ['old', 'new'];
    const seen = [];
    const out = await run(
      'models',
      null,
      {
        fetch: async (r) => {
          if (r.url.endsWith('/client/llm_tokens')) return json({ token: tokens.shift() });
          seen.push(r.headers.Authorization);
          return seen.length === 1 ? json('stale', 401, { 'x-zed-expired-token': '1' }) : json({ models: [{ id: 'm', provider: 'google' }] });
        },
      },
      { key: '72', secret: JSON.stringify({ ...S, userId: '72', access: 'acc72' }) },
    );
    expect(out[0].id).toBe('m');
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
  });

  it('a 401 for the model token is the sign-in expired (models then fall back, usage says so)', async () => {
    const out = await run('usage', null, { fetch: async () => json({}, 401) });
    expect(out).toEqual({ error: 'me: the Zed sign-in has expired — sign in again', expired: true });
  });
});

describe('usage', () => {
  it('says the plan, when its period ends, and an overdue invoice; saves a changed plan', async () => {
    const out = await run('usage', null, { fetch: async () => json({ plan: { plan_v3: 'zed_pro_trial', subscription_period: { ended_at: '2026-11-01T00:00:00Z' }, has_overdue_invoices: true } }) });
    expect(out.plan).toBe('Pro Trial');
    expect(out.until).toBe('2026-11-01T00:00:00Z');
    expect(out.error).toMatch(/overdue invoice/);
    const acc = globalThis.__astraTestHost.accounts.get('zed').get('7');
    expect(JSON.parse(acc.secret).plan).toBe('zed_pro_trial');
    expect(acc.plan).toBe('Pro Trial');
  });

  it('an unreadable reply is an error, no account is an error', async () => {
    expect((await run('usage', null, { fetch: async () => json('[1]') })).error).toMatch(/unreadable account: json: cannot unmarshal array/);
    expect(await usage(null)).toEqual({ error: 'no such Zed account' });
  });
});

describe('prepare', () => {
  const REQ = (protocol, body, extra = {}) => ({ protocol, model: body.model ?? 'm1', path: '/x', method: 'POST', headers: {}, body, stream: true, ...extra });
  const tokenFetch = async (r) => (r.url.endsWith('/client/llm_tokens') ? json({ token: 'mt' }) : json({}));

  it('wraps an Anthropic request for Zed with a minted model token, without a stream field and with is_error on tool results', async () => {
    const body = { model: 'claude-sonnet-5', stream: true, max_tokens: 5, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] }] };
    const out = await run('prepare', REQ('anthropic', body, { model: 'claude-sonnet-5' }), { fetch: tokenFetch });
    expect(out.url).toBe('https://cloud.zed.dev/completions');
    expect(out.headers.Authorization).toBe('Bearer mt');
    expect(out.headers['x-zed-client-supports-status-messages']).toBe('true');
    expect(out.body.provider).toBe('anthropic');
    expect(out.body.model).toBe('claude-sonnet-5');
    expect(out.body.provider_request.stream).toBeUndefined();
    expect(out.body.provider_request.messages[0].content[0].is_error).toBe(false);
    expect(body.stream).toBe(true); // the host's body is left alone
  });

  it('wraps the other wires the way Zed takes them', async () => {
    const chat = await run('prepare', REQ('chat', { model: 'grok-4.7', max_tokens: 9, messages: [] }, { model: 'grok-4.7' }), { fetch: tokenFetch });
    expect(chat.body).toMatchObject({ provider: 'x_ai', model: 'grok-4.7', provider_request: { stream: true, max_completion_tokens: 9 } });
    expect(chat.body.provider_request.max_tokens).toBeUndefined();
    const resp = await run('prepare', REQ('responses', { model: 'gpt-5.5', stream: false, input: 'hi' }, { model: 'gpt-5.5', stream: false }), { fetch: tokenFetch });
    expect(resp.body).toMatchObject({ provider: 'open_ai', provider_request: { stream: true, input: 'hi' } });
    const gem = await run('prepare', REQ('gemini', { contents: [], session_id: 's' }, { model: 'gemini-3.5-flash' }), { fetch: tokenFetch });
    expect(gem.body).toMatchObject({ provider: 'google', model: 'gemini-3.5-flash', provider_request: { model: 'models/gemini-3.5-flash', contents: [] } });
    expect(gem.body.provider_request.session_id).toBeUndefined();
  });

  it('says so when the account is signed out, or Zed refuses its sign-in', async () => {
    await expect(run('prepare', REQ('chat', {}), {}, null)).rejects.toThrow(/no Zed account/);
    await expect(run('prepare', REQ('chat', {}), { fetch: async () => json({}, 401) }, { key: '73', secret: JSON.stringify({ userId: '73', access: 'a73', org: 'o' }) })).rejects.toThrow(
      /sign-in has expired/,
    );
  });

  it('refresh mints a new model token, and marks the account expired when Zed refuses its sign-in', async () => {
    const ok = await run('refresh', { status: 401, body: '' }, { fetch: tokenFetch }, { key: '74', secret: JSON.stringify({ userId: '74', access: 'a74', org: 'o' }) });
    expect(ok).toBe('renewed');
    const gone = await run('refresh', { status: 401, body: '' }, { fetch: async () => json({}, 401) }, { key: '75', secret: JSON.stringify({ userId: '75', access: 'a75', org: 'o' }) });
    expect(gone).toBe('expired');
  });
});

describe('reply (NDJSON)', () => {
  const ev = (o) => ({ json: { event: o } });
  const status = (s) => ({ json: { status: s } });
  const wrappedHeaders = { 'x-zed-server-supports-status-messages': 'true' };
  const go = (protocol, frames, extra = {}) =>
    runResponse(plugin, 'zed', { framing: 'ndjson', frames, request: { protocol, stream: true, model: 'm' }, response: { headers: wrappedHeaders }, ...extra }, { permissions: PERMS });
  const whole = (protocol) => ({ request: { protocol, stream: false, model: 'm' } });

  const anthropicFrames = [
    status('started'),
    ev({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    status({ queued: { position: 1 } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
    ev({ type: 'content_block_stop', index: 0 }),
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
    ev({ type: 'message_stop' }),
    status('stream_ended'),
  ];

  it('streams Anthropic events as event/data pairs, holding the lead until the reply says something', async () => {
    const out = await go('anthropic', anthropicFrames);
    expect(out.failure).toBeNull();
    expect(out.frames.map((f) => f.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(out.frames[2].data.delta.text).toBe('Hel');
  });

  it('assembles the same events into one message for a caller that did not ask for a stream', async () => {
    const out = await go('anthropic', anthropicFrames, whole('anthropic'));
    expect(out.failure).toBeNull();
    expect(out.body).toMatchObject({ id: 'msg_1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 3, output_tokens: 2 } });
  });

  it('streams chat chunks as they are and ends with [DONE]; assembles them for a whole reply', async () => {
    const chunks = [
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'grok', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      { id: 'c1', object: 'chat.completion.chunk', model: 'grok', choices: [{ index: 0, delta: { content: 'Hi' } }] },
      { id: 'c1', object: 'chat.completion.chunk', model: 'grok', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'k', function: { name: 'f', arguments: '{"a"' } }] } }] },
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        model: 'grok',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }],
        usage: { total_tokens: 7 },
      },
    ];
    const frames = [...chunks.map(ev), status('stream_ended')];
    const s = await go('chat', frames);
    expect(s.frames).toHaveLength(5); // the role-only lead is held, then sent with the first that says something; [DONE] last
    expect(s.frames[0].choices[0].delta.role).toBe('assistant');
    expect(s.frames.at(-1)).toBe('[DONE]');
    const w = await go('chat', frames, whole('chat'));
    expect(w.body.choices[0].message).toMatchObject({ content: 'Hi', tool_calls: [{ id: 'k', function: { name: 'f', arguments: '{"a":1}' } }] });
    expect(w.body.usage).toEqual({ total_tokens: 7 });
  });

  it('streams Responses events with their event names, and a Gemini stream as it is', async () => {
    const r = await go('responses', [
      ev({ type: 'response.created', response: {} }),
      ev({ type: 'response.output_text.delta', delta: 'x' }),
      ev({ type: 'response.completed', response: { id: 'r', output: [] } }),
      status('stream_ended'),
    ]);
    expect(r.frames.map((f) => f.event)).toEqual(['response.created', 'response.output_text.delta', 'response.completed']);
    const done = await go(
      'responses',
      [ev({ type: 'response.created', response: {} }), ev({ type: 'response.completed', response: { id: 'r', output: [] } }), status('stream_ended')],
      whole('responses'),
    );
    expect(done.body).toEqual({ id: 'r', output: [] });
    const gem = [
      ev({ candidates: [{ content: { parts: [{ text: 'a' }] } }] }),
      ev({ candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } }),
      status('stream_ended'),
    ];
    expect((await go('gemini', gem)).frames).toHaveLength(2);
    const gw = await go('gemini', gem, whole('gemini'));
    expect(gw.body.candidates[0]).toMatchObject({ finishReason: 'STOP', content: { parts: [{ text: 'ab' }] } });
  });

  it('reads bare events when the reply did not say it sends statuses', async () => {
    const out = await go('chat', [{ json: { id: 'c', choices: [{ index: 0, delta: { content: 'x' } }] } }], { response: { headers: {} } });
    expect(out.frames).toHaveLength(2);
    expect(out.frames.at(-1)).toBe('[DONE]');
  });

  it('turns a failed status before the reply began into a refused request (429 for a rate limit)', async () => {
    const out = await go('anthropic', [status('started'), status({ failed: { code: 'rate_limit_exceeded', message: 'slow down' } })]);
    expect(out.failure).toEqual({ status: 429, message: 'slow down' });
    const up = await go('chat', [status({ failed: { code: 'upstream_http_503', message: 'down' } })]);
    expect(up.failure).toEqual({ status: 503, message: 'down' });
  });

  it("refuses the provider's own error event in the lead, but lets one after the reply began through", async () => {
    const lead = await go('anthropic', [ev({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } })]);
    expect(lead.failure).toEqual({ status: 502, message: 'busy' });
    const later = await go('anthropic', [
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } }),
      ev({ type: 'error', error: { message: 'boom' } }),
      status('stream_ended'),
    ]);
    expect(later.failure).toBeNull();
    expect(later.frames.map((f) => f.event)).toEqual(['content_block_delta', 'error']);
  });

  it('fails a reply that ends before stream_ended, or ends without saying anything', async () => {
    const cut = await go('anthropic', anthropicFrames.slice(0, 5));
    expect(cut.failure).toEqual({ status: 502, message: 'the reply ended before it was complete' });
    const none = await go('anthropic', [status('started'), ev({ type: 'message_start', message: {} }), status('stream_ended')]);
    expect(none.failure).toEqual({ status: 502, message: 'Zed ended without an answer' });
    const bad = await go('anthropic', [{ text: 'not json' }]);
    expect(bad.failure).toEqual({ status: 502, message: 'Zed: an unreadable line' });
  });

  it("maps Zed's refusals to the status they stand for", async () => {
    const r = (status, body) =>
      runResponse(plugin, 'zed', { framing: 'ndjson', frames: [], request: { protocol: 'chat', stream: true }, response: { status, headers: {}, body } }, { permissions: PERMS });
    expect((await r(402, '')).error.status).toBe(402);
    expect((await r(401, '')).error).toMatchObject({ status: 401 });
    expect((await r(400, JSON.stringify({ code: 'x', message: 'bad', upstream_status: 429, retry_after: 7 }))).error).toEqual({ status: 429, message: 'bad (retry after 7s)' });
    expect((await r(503, 'down')).error).toEqual({ status: 503, message: 'down' });
  });
});

describe('sign-in flow', () => {
  const me = { default_organization_id: 'o1', organizations: [{ id: 'o1' }], user: { github_login: 'octo', email: 'o@x.io' }, plan: { plan_v3: 'zed_pro' } };
  const submit = async (fetch, id = ' 7 ', token = ' tok ') => {
    const view = await mount(signIn, { permissions: PERMS, fetch });
    await view.change('userId', id);
    await view.change('access', token);
    return { view, effects: await view.press('save') };
  };

  it('asks Zed who the pair is and adds the account with the organization and plan', async () => {
    const calls = [];
    const { effects } = await submit(async (r) => (calls.push(r), json(me)));
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    expect(calls[0].headers.Authorization).toBe('7 tok');
    const acc = globalThis.__astraTestHost.accounts.get('zed').get('7');
    expect(acc).toMatchObject({ key: '7', displayName: 'octo', email: 'o@x.io', plan: 'Pro' });
    expect(JSON.parse(acc.secret)).toMatchObject({ userId: '7', access: 'tok', org: 'o1', plan: 'zed_pro', who: 'octo' });
  });

  it('refuses a pair Zed turns down, an organization with hosted models off, and empty fields', async () => {
    const a = await submit(async () => json({}, 401));
    expect(a.effects.some((e) => e.type === 'close')).toBe(false);
    const b = await submit(async () => json({ ...me, configuration_by_organization: { o1: { is_zed_model_provider_enabled: false } } }));
    expect(b.effects.some((e) => e.type === 'close')).toBe(false);
    const c = await submit(async () => json(me), '', '');
    expect(c.effects.some((e) => e.type === 'close')).toBe(false);
    expect(globalThis.__astraTestHost.accounts.get('zed')?.size ?? 0).toBe(0);
  });
});
