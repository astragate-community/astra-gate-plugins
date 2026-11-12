import { describe, expect, it } from 'vitest';
import { mount, runProvider } from '@astragate/plugin-sdk/testing';
import plugin, { signIn } from '../src/main.js';
import { PERMS, claude, jwt, live, routed } from './support.js';

const accounts = () => globalThis.__astraTestHost.accounts.get('cursor');
const oauth = (extra = {}) => ({ key: 'me@x.io', secret: JSON.stringify({ type: 'oauth', access: live(), refresh: 'none', expires: 0, ...extra }) });
const apiKey = (key = 'key-1') => ({ key: 'key-acct', secret: JSON.stringify({ type: 'api', key }) });
const run = (what, request, account, opts) => runProvider(plugin, 'cursor', what, request, account, { permissions: PERMS, ...opts });

describe('models', () => {
  const picker = (c) => (c.url.endsWith('AvailableModels') ? { body: { models: [claude] } } : { body: { models: [{ modelId: 'claude-x-low' }, { displayModelId: 'claude-x-low-1m' }] } });

  it("without an account the built-in Auto is the list", async () => {
    expect(await run('models', null, null)).toEqual([{ id: 'auto', name: 'Auto', protocol: 'chat', context: 200000, vision: true }]);
  });

  it('the picker, less what the usable list lacks, each model once for each context size', async () => {
    const { fetch } = routed([['Models', picker]]);
    const got = await run('models', null, oauth(), { fetch });
    expect(got.map((m) => [m.id, m.name, m.context, m.reasoning])).toEqual([['claude-x@200k', 'Claude X @ 200k', 200000, true], ['claude-x@1m', 'Claude X @ 1m', 1000000, true]]);
    expect(got[0]).toMatchObject({ protocol: 'chat', vision: true });
  });

  it('the list is kept per account: the second read asks nothing', async () => {
    const { fetch, calls } = routed([['Models', picker]]);
    await run('models', null, oauth(), { fetch, storage: {} });
    const n = calls.length;
    expect(n).toBe(2);
    await run('models', null, oauth(), { fetch, storage: { ['models2:me@x.io']: { at: Date.now(), raw: [{ id: 'kept', name: 'K', context: 1, levels: {} }] } } });
    expect(calls).toHaveLength(n);
  });

  it('a picker with no models is a failure', async () => {
    const { fetch } = routed([['Models', { body: { models: [] } }]]);
    await expect(run('models', null, oauth(), { fetch })).rejects.toThrow(/listed no models/);
  });

  it('a lapsed sign-in says to sign in again, an API key is exchanged', async () => {
    await expect(run('models', null, oauth({ access: jwt({ exp: 1 }), expires: Date.now() - 1 }))).rejects.toThrow(/run out/);
    const tok = live();
    const { fetch, calls } = routed([['exchange_user_api_key', { body: { accessToken: tok } }], ['Models', picker]]);
    await run('models', null, apiKey(), { fetch });
    expect(calls[0].url).toMatch(/\/auth\/exchange_user_api_key$/);
    expect(calls[0].headers.authorization).toBe('Bearer key-1');
    expect(calls[1].headers.authorization).toBe('Bearer ' + tok);
  });
});

describe('refresh', () => {
  it('a browser sign-in cannot be renewed; an API key is exchanged again', async () => {
    expect(await run('refresh', null, oauth())).toBe('expired');
    const { fetch } = routed([['exchange_user_api_key', { body: { accessToken: live() } }]]);
    expect(await run('refresh', null, apiKey(), { fetch })).toBe('renewed');
    const { fetch: refused } = routed([['exchange_user_api_key', { status: 401 }]]);
    expect(await run('refresh', null, apiKey(), { fetch: refused })).toBe('expired');
  });
});

describe('usage', () => {
  const period = { planUsage: { autoPercentUsed: 10, apiPercentUsed: 20, totalPercentUsed: 30 }, billingCycleEnd: '1893456000000', autoBucketModels: ['claude-x'] };
  const routes = (extra = []) => [
    ...extra,
    ['GetHardLimit', { body: { hardLimit: 50 } }],
    ['GetCurrentPeriodUsage', { body: period }],
    ['GetPlanInfo', { body: { planInfo: { planName: ' Pro+ ' } } }],
    ['Models', (c) => (c.url.endsWith('AvailableModels') ? { body: { models: [claude] } } : { status: 500 })],
    ['get-sand-usage-status', { body: { includedLimitZero: false, usagePercent: 140 } }],
  ];

  it('two pools, on-demand spend, Grok Bot before the total, the plan on the card', async () => {
    const sub = JSON.stringify({ sub: 'auth0|user_1', exp: Math.floor(Date.now() / 1000) + 3600 });
    const access = `h.${Buffer.from(sub).toString('base64url')}.s`;
    const { fetch, calls } = routed(routes());
    const card = await run('usage', null, oauth({ access }), { fetch });
    expect(card.plan).toBe('Pro+');
    expect(card.windows.map((w) => w.name)).toEqual(['Cursor Models', 'Other Models', 'On-demand', 'Grok Bot', 'Total']);
    expect(card.windows[0]).toMatchObject({ used: 10, aside: true });
    expect(card.windows[0].models).toEqual(expect.arrayContaining(['auto', 'claude-x@1m', 'claude-x']));
    expect(card.windows[2]).toMatchObject({ display: '$0.00 / $50.00', resetsAt: '2030-01-01T00:00:00.000Z' });
    expect(card.windows[3]).toEqual({ name: 'Grok Bot', used: 100, aside: true });
    const bot = calls.find((c) => c.url.includes('get-sand-usage-status'));
    expect(bot.headers.cookie).toBe('WorkosCursorSessionToken=' + encodeURIComponent('user_1::' + access));
  });

  it('a refused call says its status; an enterprise plan has no windows', async () => {
    const { fetch } = routed([['GetCurrentPeriodUsage', { status: 503 }], ['GetHardLimit', { status: 500 }], ['GetPlanInfo', { status: 500 }], ['get-sand', { status: 500 }], ['Models', { status: 500 }]]);
    expect((await run('usage', null, oauth(), { fetch })).error).toBe('Service Unavailable');
    const { fetch: bare } = routed([['GetCurrentPeriodUsage', { body: {} }], ['GetHardLimit', { status: 500 }], ['GetPlanInfo', { status: 500 }], ['get-sand', { status: 500 }], ['Models', { status: 500 }]]);
    expect((await run('usage', null, oauth(), { fetch: bare })).windows).toEqual([]);
  });

  it('a lapsed sign-in is an error card', async () => {
    expect(await run('usage', null, oauth({ access: jwt({ exp: 1 }), expires: Date.now() - 1 }))).toMatchObject({ error: expect.stringMatching(/run out/), windows: [] });
  });
});

describe('sign-in flow', () => {
  const open = (fetch) => mount(signIn, { permissions: PERMS, fetch });

  it('offers the browser login and an API key', async () => {
    const view = await open();
    expect(view.findAll('Button').map((b) => b.props.label)).toEqual(['signIn.browser', 'signIn.key']);
  });

  it('the browser login opens loginDeepControl with a PKCE challenge, polls through a 404 and keeps the account', async () => {
    const access = live();
    let polls = 0;
    const { fetch, calls } = routed([
      ['/auth/poll', () => (++polls < 2 ? { status: 404 } : { body: { accessToken: access, refreshToken: 'r' } })],
      ['GetMe', { body: { email: 'me@x.io' } }],
      ['GetPlanInfo', { body: { planInfo: { planName: 'Pro' } } }],
    ]);
    const view = await open(fetch);
    const effects = await view.press('browser');
    const url = effects.map((e) => e.url ?? e.href ?? '').find((u) => u.includes('loginDeepControl')) ?? '';
    expect(url).toMatch(/^https:\/\/cursor\.com\/loginDeepControl\?challenge=[\w-]{43}&uuid=[0-9a-f-]{36}&mode=login&redirectTarget=cli$/);
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    // the poll carries the verifier whose SHA-256 is the challenge
    const poll = calls.find((c) => c.url.includes('/auth/poll')).url;
    const verifier = /verifier=([\w-]+)/.exec(poll)[1];
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(/challenge=([\w-]+)/.exec(url)[1]);
    expect(JSON.parse(accounts().get('me@x.io').secret)).toMatchObject({ type: 'oauth', access, refresh: 'r' });
    expect(accounts().get('me@x.io')).toMatchObject({ email: 'me@x.io', plan: 'Pro' });
  }, 15000);

  it('a refused poll says so and leaves the choice open', async () => {
    const { fetch } = routed([['/auth/poll', { status: 403 }]]);
    const view = await open(fetch);
    await view.press('browser');
    expect(view.state.error).toMatch(/refused the sign-in \(403\)/);
    expect(view.state.step).toBe('choose');
  });

  it('the browser login gives up after three failed polls', async () => {
    const { fetch } = routed([['/auth/poll', { status: 500 }]]);
    const view = await mount(signIn, { permissions: PERMS, fetch });
    await view.press('browser');
    expect(view.state.error).toMatch(/answered HTTP 500/);
  });

  it('an API key is exchanged, checked against Cursor and added under the account\'s email', async () => {
    const { fetch } = routed([
      ['exchange_user_api_key', { body: { accessToken: live() } }],
      ['GetMe', { body: { email: 'key@x.io' } }],
      ['GetPlanInfo', { body: { planInfo: { planName: 'Ultra' } } }],
    ]);
    const view = await open(fetch);
    await view.press('key');
    await view.change('key', ' secret-key ');
    const effects = await view.press('submitKey');
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    expect(JSON.parse(accounts().get('key@x.io').secret)).toEqual({ type: 'api', key: 'secret-key' });
    expect(accounts().get('key@x.io').plan).toBe('Ultra');
  });

  it('a key Cursor refuses is an error in the field and adds nothing', async () => {
    const { fetch } = routed([['exchange_user_api_key', { status: 401 }]]);
    const view = await open(fetch);
    await view.press('key');
    await view.change('key', 'bad');
    const effects = await view.press('submitKey');
    expect(JSON.stringify(effects)).toMatch(/didn't take this API key/);
    expect(accounts()?.size ?? 0).toBe(0);
  });
});
