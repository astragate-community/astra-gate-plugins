import { describe, expect, it } from 'vitest';
import { runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin from '../src/main.js';
import { PERMS, balance, jwtExpiring, ok, routed } from './support.js';

const ZAI = 'https://api.z.ai/api/anthropic';
const state = (s) => JSON.stringify({ site: 'zai', base: ZAI, device: 'dev', ...s });
const acct = (s) => ({ key: 'me', secret: state(s) });
const req = (body, extra = {}) => ({ protocol: 'anthropic', model: body?.model ?? null, path: '/v1/messages', method: 'POST', headers: {}, body, stream: true, ...extra });
const run = (what, request, account, opts) => runProvider(plugin, 'zcode', what, request, account, { permissions: PERMS, ...opts });

describe('prepare', () => {
  it('a coding key goes as the key to the plan\'s own endpoint', async () => {
    const out = await run('prepare', req({ model: 'GLM-5.2', messages: [] }, { headers: { 'x-keep': '1' } }), acct({ key: 'id.secret' }));
    expect(out.url).toBe(ZAI + '/v1/messages');
    expect(out.headers['x-api-key']).toBe('id.secret');
    expect(out.headers.authorization).toBe('Bearer id.secret');
    expect(out.headers['x-keep']).toBe('1');
    expect(out.body).toBeUndefined(); // the agent's body goes as it is
  });

  it("BigModel's key goes to BigModel's endpoint", async () => {
    const out = await run('prepare', req({ model: 'GLM-5.2', messages: [] }), acct({ site: 'bigmodel', base: undefined, key: 'k.s' }));
    expect(out.url).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages');
  });

  it('a state with no key and no token says to sign in again', async () => {
    await expect(run('prepare', req({ messages: [] }), acct({ key: '' }))).rejects.toThrow(/sign in again/);
    await expect(run('prepare', req({ messages: [] }), null)).rejects.toThrow(/not signed in/);
  });

  it('a Start Plan account sends the dressed body to zcode.z.ai with its token', async () => {
    const jwt = jwtExpiring(3600);
    const out = await run(
      'prepare',
      req({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }] }, { headers: { 'x-magpie-work-dir': '%2Fw', 'x-api-key': 'x' } }),
      acct({ jwt, key: '', locale: 'en-US' }),
    );
    expect(out.url).toBe('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages');
    expect(out.headers.authorization).toBe('Bearer ' + jwt);
    expect(out.headers['x-magpie-work-dir']).toBeUndefined();
    expect(out.headers['x-api-key']).toBeUndefined();
    expect(out.headers['x-client-language']).toBe('en-US');
    expect(out.body.system).toHaveLength(3);
    expect(out.body.messages[0].content[0].text).toMatch(/Primary working directory: \/w/);
    expect(JSON.parse(out.body.metadata.user_id).device_id).toBe('dev');
  });

  it('an expired Start Plan token says so before anything is asked', async () => {
    const { fetch, calls } = routed([]);
    await expect(run('prepare', req({ messages: [] }), acct({ jwt: jwtExpiring(-60), key: '' }), { fetch })).rejects.toThrow(/expired/);
    expect(calls).toHaveLength(0);
  });

  // a coding account that also holds a gift: the -Trial entry spends the gift
  const dual = () => acct({ key: 'a.b', jwt: jwtExpiring(3600) });
  const dualRoutes = (gift) => [
    ['/subscription/list', ok([{ status: 'VALID', productName: 'Pro' }])],
    ['/billing/balance', ok(balance(gift))],
  ];

  it('a plain model of a dual account stays on the coding plan', async () => {
    const { fetch } = routed(dualRoutes());
    const out = await run('prepare', req({ model: 'GLM-5.3-Flash', messages: [] }), dual(), { fetch });
    expect(out.url).toBe(ZAI + '/v1/messages');
    expect(out.headers['x-api-key']).toBe('a.b');
  });

  it('a -Trial model asks the gift under its raw name', async () => {
    const { fetch } = routed(dualRoutes());
    const out = await run('prepare', req({ model: 'GLM-5.3-Flash-Trial', messages: [{ role: 'user', content: 'hi' }] }), dual(), { fetch });
    expect(out.url).toContain('/zcode-plan/anthropic/v1/messages');
    expect(out.body.model).toBe('glm-5.3-flash');
    expect(out.headers.authorization).toMatch(/^Bearer /);
  });

  it('a -Trial model the gift has none of is refused without a request going out', async () => {
    const { fetch } = routed(dualRoutes({ models: ['glm-5.2'] }));
    await expect(run('prepare', req({ model: 'GLM-5.3-Flash-Trial', messages: [] }), dual(), { fetch })).rejects.toThrow(/no active limited quota/);
  });

  it('a -Trial model whose bucket is spent is refused as a rate limit', async () => {
    const { fetch } = routed(dualRoutes({ remaining: 0 }));
    await expect(run('prepare', req({ model: 'GLM-5.3-Flash-Trial', messages: [] }), dual(), { fetch })).rejects.toThrow(/exhausted or temporarily unavailable/);
  });

  it('an account with no coding plan sends everything to the gift', async () => {
    const { fetch } = routed([['/subscription/list', ok([])], ['/billing/balance', ok(balance())]]);
    const out = await run('prepare', req({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }] }), dual(), { fetch });
    expect(out.url).toContain('/zcode-plan/anthropic/');
    expect(out.body.system).toHaveLength(3);
  });

  it('a team seat with no key makes one, keeps it and sends it', async () => {
    const { fetch } = routed([
      ['/api_keys/copy/', ok({ secretKey: 'sec' })],
      ['/api_keys', (r) => (r.method === 'POST' ? ok({ apiKey: 'id1' }) : ok([]))],
    ]);
    const out = await run('prepare', req({ model: 'GLM-5.2', messages: [] }), acct({ key: '', token: 'Bearer t', org: 'o', project: 'p' }), { fetch });
    expect(out.headers['x-api-key']).toBe('id1.sec');
    const stored = JSON.parse(globalThis.__astraTestHost.accounts.get('zcode')?.get('me')?.secret ?? '{}');
    expect(stored.key).toBe('id1.sec');
  });
});

describe('refresh', () => {
  it("makes a team seat's key again, and leaves other accounts as they are", async () => {
    const { fetch, calls } = routed([
      ['/api_keys/copy/', ok({ secretKey: 'sec' })],
      ['/api_keys', (r) => (r.method === 'POST' ? ok({ apiKey: 'id2' }) : ok([]))],
    ]);
    expect(await run('refresh', null, acct({ key: 'old', token: 'Bearer t', org: 'o', project: 'p' }), { fetch })).toBe('renewed');
    expect(calls.length).toBeGreaterThan(0);
    expect(await run('refresh', null, acct({ key: 'k.s' }), { fetch })).toBeNull();
  });
});

describe('models', () => {
  const cfg = {
    config: {
      providerConfigRules: { providerRules: [{ providerId: 'account:zai-individual-coding-plan', builtinModelIds: ['GLM-5.2'] }] },
      modelConfigRules: { modelRules: [{ modelMatch: 'glm-5\\..*', config: { properties: { contextWindow: 1000, inputFormat: { supportsImage: true } }, optionSpecs: { maxOutputTokens: { max: 64 }, reasoningLevel: { values: ['disabled', 'enabled'] } } } }] },
    },
  };

  it('with no account the built-in table stands in', async () => {
    const got = await run('models', null, null);
    expect(got.map((m) => m.id)).toEqual(['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo']);
    expect(got[0]).toMatchObject({ protocol: 'anthropic', context: 1000000, output: 128000, reasoning: true });
  });

  it("a coding account's models come from ZCode's config, with the gift's as -Trial entries", async () => {
    const { fetch } = routed([
      ['/api/v1/client/configs', ok({ configs: { builtin_provider_config_json: 'https://cdn.example/cfg.json' } })],
      ['cdn.example', { body: cfg }],
      ['/subscription/list', ok([{ status: 'VALID', productName: 'Pro' }])],
      ['/billing/balance', ok(balance({ models: ['glm-5.3-flash'] }))],
    ]);
    const got = await run('models', null, acct({ key: 'a.b', jwt: jwtExpiring(3600) }), { fetch, permissions: [...PERMS, 'net:https://cdn.example'] });
    expect(got.map((m) => m.id)).toEqual(['GLM-5.2', 'GLM-5.3-Flash-Trial']);
    expect(got[0]).toMatchObject({ context: 1000, output: 64, vision: true, reasoning: true });
  });

  it("a config host the plugin may not reach leaves the built-in table, and a Start Plan account lists the gift's models by name", async () => {
    const { fetch } = routed([
      ['/api/v1/client/configs', ok({ configs: { builtin_provider_config_json: 'https://cdn.example/cfg.json' } })],
      ['/billing/balance', ok(balance({ models: ['glm-5.3'] }))],
    ]);
    const got = await run('models', null, acct({ jwt: jwtExpiring(3600), key: '' }), { fetch });
    expect(got.map((m) => m.id)).toEqual(['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo', 'GLM-5.3', 'GLM-5.3-Trial']);
  });
});

describe('usage', () => {
  it("a coding key's card: level, windows and the term", async () => {
    const { fetch } = routed([
      ['/quota/limit', ok({ level: 'pro', limits: [{ unit: 3, number: 5, usage: 200, remaining: 150, percentage: 25 }] })],
      ['/subscription/list', ok([{ status: 'VALID', nextRenewTime: '2026-10-18 12:00:00', autoRenew: true }])],
      ['/billing/preview', ok({ plans: [] })],
    ]);
    const card = await run('usage', null, acct({ key: 'a.b' }), { fetch });
    expect(card.plan).toBe('GLM Coding Pro');
    expect(card.windows[0]).toMatchObject({ name: '5 hours', used: 25, display: '50 / 200' });
    expect(card).toMatchObject({ renew: 'auto', until: '2026-10-18T04:00:00.000Z' });
  });

  it('a gift-only account shows its buckets, or says it has none', async () => {
    const jwt = jwtExpiring(3600);
    const { fetch } = routed([['/billing/balance', ok(balance())], ['/billing/preview', ok({ plans: [] })]]);
    const card = await run('usage', null, acct({ jwt, key: '', plan: 'Start Plan' }), { fetch });
    expect(card.windows[0].models).toEqual(['glm-5.3-flash', 'GLM-5.3-Flash-Trial']);
    const { fetch: none } = routed([['/billing/balance', ok({ plans: [], balances: [] })]]);
    expect((await run('usage', null, acct({ jwt, key: '' }), { fetch: none })).error).toMatch(/no GLM Coding Plan/);
  });

  it('a dual account shows both allowances and names a gift to claim in the app', async () => {
    const { fetch } = routed([
      ['/quota/limit', ok({ limits: [{ unit: 6, number: 1, percentage: 40 }] })],
      ['/subscription/list', ok([{ status: 'VALID', productName: 'Pro' }])],
      ['/billing/balance', ok(balance({ models: ['glm-5.3-flash'] }))],
      ['/billing/preview', ok({ plans: [{ plan_id: 'g', name: 'ZCode Trust Build' }] })],
    ]);
    const card = await run('usage', null, acct({ key: 'a.b', jwt: jwtExpiring(3600), plan: 'Pro' }), { fetch });
    expect(card.plan).toBe('Pro');
    expect(card.windows.map((w) => w.name)).toEqual(['Weekly', 'GLM-5.3-Flash-Trial', 'Gift plans to claim in the ZCode app']);
    expect(card.windows[0].notModels).toEqual(['glm-5.3-flash-trial']);
    expect(card.windows.at(-1)).toMatchObject({ aside: true, display: '1 · ZCode Trust Build' });
  });

  it('a failed read is an error card that keeps the saved plan', async () => {
    const { fetch } = routed([['/quota/limit', { status: 503, body: 'x' }]]);
    const card = await run('usage', null, acct({ key: 'a.b', plan: 'Pro' }), { fetch });
    expect(card).toMatchObject({ error: 'Service Unavailable', plan: 'Pro' });
  });
});

// ---- the gift's refusals (reply.js): a spent bucket is a 429, a quota error inside a 200 too
describe('reply', () => {
  const A = { key: 'me', secret: state({ jwt: jwtExpiring(3600), key: '' }) };
  const reply = (input) => runResponse(plugin, 'zcode', { framing: 'ndjson', account: A, ...input }, { permissions: PERMS });
  const trial = { model: 'GLM-5.3-Flash-Trial', stream: true };
  const lines = (...ls) => ls.map((text) => ({ text }));
  const quota = { code: 1113, msg: 'Insufficient balance or no resource package. Please recharge.', success: false };

  it('a quota error inside an HTTP 200 JSON body becomes a 429', async () => {
    const out = await reply({ request: trial, frames: [{ json: quota }] });
    expect(out.failure).toEqual({ status: 429, message: 'Insufficient balance or no resource package. Please recharge.' });
    const nested = await reply({ request: trial, frames: [{ json: { error: { code: '1005', message: 'exceed quota limit' } } }] });
    expect(nested.failure).toMatchObject({ status: 429 });
  });

  it('a 4xx that says spent becomes a 429; a 429 goes as it came; any other answer too', async () => {
    const spent = await reply({ request: trial, response: { status: 400, body: JSON.stringify(quota) } });
    expect(spent.error).toMatchObject({ status: 429, message: expect.stringContaining('Insufficient balance') });
    const limited = await reply({ request: trial, response: { status: 429, body: '{"error":{"code":"1302","message":"rate limit"}}' } });
    expect(limited.error).toBeNull();
    expect(limited.status).toBe(429);
    for (const status of [401, 405, 503]) {
      const out = await reply({ request: trial, response: { status, body: '{"msg":"nope"}' } });
      expect(out.error).toBeNull();
      expect(out.status).toBe(status);
    }
  });

  it('a spent gift keeps that trial entry off for a minute, in prepare too', async () => {
    const gift = routed([['/subscription/list', ok([{ status: 'VALID', productName: 'Pro' }])], ['/billing/balance', ok(balance({ models: ['glm-5.3-flash'] }))]]);
    const acct2 = { key: 'blk', secret: state({ jwt: jwtExpiring(3600), key: 'k.s' }) };
    const prep = () => run('prepare', req({ model: 'GLM-5.3-Flash-Trial', messages: [] }), acct2, { fetch: gift.fetch });
    expect((await prep()).url).toContain('zcode-plan');
    await runResponse(plugin, 'zcode', { framing: 'ndjson', account: acct2, request: trial, response: { status: 429, body: '{}' } }, { permissions: PERMS });
    await expect(prep()).rejects.toThrow(/exhausted or temporarily unavailable/);
  });

  it('only a gift (-Trial) request is judged: another request\'s quota text goes on', async () => {
    const out = await reply({ request: { model: 'GLM-5.2', stream: true }, response: { status: 400, body: JSON.stringify(quota) } });
    expect(out.error).toBeNull();
    expect(out.status).toBe(400);
  });

  it('puts the event lines of an Anthropic stream back together', async () => {
    const msg = { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } };
    const delta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } };
    const out = await reply({ request: trial, frames: lines('event: message_start', 'data: ' + JSON.stringify(msg), ': keep-alive', 'event: content_block_delta', 'data: ' + JSON.stringify(delta), 'data: [DONE]') });
    expect(out.failure).toBeNull();
    expect(out.frames).toEqual([{ event: 'message_start', data: msg }, { event: 'content_block_delta', data: delta }]);
  });

  it('passes a one-body reply through, single-line or pretty-printed', async () => {
    const message = { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
    const one = await reply({ request: { model: 'GLM-5.2', stream: false }, frames: [{ json: message }] });
    expect(one.body).toEqual(message);
    const pretty = await reply({ request: { model: 'GLM-5.2', stream: false }, frames: lines(...JSON.stringify(message, null, 2).split('\n')) });
    expect(pretty.body).toEqual(message);
    const none = await reply({ request: { model: 'GLM-5.2', stream: false }, frames: [] });
    expect(none.body).toBeUndefined();
  });

  it('a quota error in a pretty-printed one-body reply is a 429 too', async () => {
    const out = await reply({ request: trial, frames: lines(...JSON.stringify(quota, null, 2).split('\n')) });
    expect(out.failure).toMatchObject({ status: 429 });
  });
});
