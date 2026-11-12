import { describe, expect, it } from 'vitest';
import { mount, runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin, { signIn } from '../src/main.js';
import { clientHeaders } from '../src/api.js';
import { authOf, bearerOf, parseAuth, toMs } from '../src/session.js';
import { chatBody, pinned, sessionOf, taskIdOf } from '../src/request.js';
import { failure } from '../src/refusals.js';
import { balanceUSD, compactNumber, creditsOf, limitWindows, timeOf, usageOf, usd } from '../src/usage.js';
import { DEFAULT_MODELS, parseFeed, prettify, tokens } from '../src/models.js';

const PERMS = ['providers', 'storage', 'ui', 'net:https://api.cline.bot', 'net:https://api.workos.com'];
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });
const env = (data) => json({ success: true, data });
const inMin = (m) => Date.now() + m * 60_000;
const oauth = (o = {}) => JSON.stringify({ type: 'oauth', access: 'tok', refresh: 'ref', expires: inMin(60), uid: 'u1', accountId: 'acc', ...o });
const chatReq = (extra = {}) => ({
  protocol: 'chat',
  model: 'anthropic/claude-sonnet-5',
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {},
  body: { model: 'anthropic/claude-sonnet-5', messages: [] },
  stream: true,
  ...extra,
});
const run = (what, request, secret, opts = {}) => runProvider(plugin, 'cline', what, request, secret === undefined ? null : { key: 'k', secret }, { permissions: PERMS, ...opts });
const accountSecret = () => JSON.parse(globalThis.__astraTestHost.accounts.get('cline').get('k').secret);

describe('credentials', () => {
  it('reads secrets, adds the routing prefix once whatever its case, and leaves an API key bare', () => {
    expect(authOf(JSON.stringify({ type: 'api', key: 'k' })).type).toBe('api');
    expect(authOf('sk-bare')).toEqual({ type: 'api', key: 'sk-bare' });
    expect(authOf(JSON.stringify({ expires: 'x' })).expires).toBe(0);
    expect(bearerOf({ type: 'api', key: 'sk-1' })).toBe('sk-1');
    expect(bearerOf({ type: 'oauth', access: 'jwt' })).toBe('workos:jwt');
    expect(bearerOf({ type: 'oauth', access: 'WorkOS:jwt' })).toBe('WorkOS:jwt');
    expect(bearerOf({ type: 'oauth', access: '' })).toBe('');
  });

  it('parseAuth reads the token answer, falling back to the old refresh token', () => {
    const exp = new Date(inMin(60)).toISOString();
    const p = parseAuth({ accessToken: 'a', refreshToken: 'r2', expiresAt: exp, userInfo: { clineUserId: 'u1', email: ' me@x.io ', name: 'Me' } }, 'r1');
    expect(p).toEqual({ access: 'a', refresh: 'r2', expires: Date.parse(exp), uid: 'u1', email: 'me@x.io', name: 'Me', accountId: 'me@x.io' });
    expect(parseAuth({ accessToken: 'a' }, 'r1').refresh).toBe('r1');
    expect(parseAuth({ accessToken: 'a', userInfo: { subject: 's' } }, 'r1').accountId).toBe('s');
    expect(parseAuth({}).error).toMatch(/no access token/);
    expect(parseAuth({ accessToken: 'a' }).error).toMatch(/no refresh token/);
  });

  it('toMs takes a missing or past expiry as an hour out', () => {
    const hour = 3600_000;
    expect(Math.abs(toMs(undefined) - (Date.now() + hour))).toBeLessThan(1000);
    expect(Math.abs(toMs('1999-01-01') - (Date.now() + hour))).toBeLessThan(1000);
    const t = Date.now() + 5 * hour;
    expect(toMs(new Date(t).toISOString())).toBe(t);
  });
});

describe('request shaping', () => {
  it("carries Cline's identity, and a task id only when given", () => {
    expect(clientHeaders()['X-CLIENT-TYPE']).toBe('cline-cli');
    expect(clientHeaders()['X-Task-ID']).toBeUndefined();
    expect(clientHeaders('t1')['X-Task-ID']).toBe('t1');
  });

  it('gives a named session a stable uuid, and an unnamed one no task', () => {
    expect(sessionOf({})).toBe('');
    expect(sessionOf({ 'x-session-id': ' s1 ' })).toBe('s1');
    const id = taskIdOf('s1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(taskIdOf('s1')).toBe(id);
    expect(taskIdOf('s2')).not.toBe(id);
  });

  it("pins DeepSeek models when asked, adding providerOptions last and keeping the client's own", () => {
    expect(pinned(true, 'cline-pass/deepseek-v4-pro')).toBe('deepseek');
    expect(pinned(true, 'deepseek/deepseek-chat')).toBe('deepseek');
    expect(pinned(true, 'cline-free/deepseek-v4.1-flash')).toBe('');
    expect(pinned(true, 'anthropic/claude-sonnet-5')).toBe('');
    expect(pinned(false, 'cline-pass/deepseek-v4-pro')).toBe('');
    const body = { model: 'cline-pass/deepseek-v4-pro', messages: [] };
    const out = chatBody(body, true);
    expect(out.providerOptions).toEqual({ gateway: { only: ['deepseek'] } });
    expect(Object.keys(out).at(-1)).toBe('providerOptions');
    expect(body.providerOptions).toBeUndefined();
    const own = { model: 'cline-pass/deepseek-v4-pro', providerOptions: { a: 1 } };
    expect(chatBody(own, true)).toBe(own);
    expect(chatBody({ model: 'cline-pass/deepseek-v4-pro' }, false).providerOptions).toBeUndefined();
  });
});

describe('prepare', () => {
  it('sends a chat completion to Cline with the account token, identity and task id', async () => {
    const r = await run('prepare', chatReq({ headers: { 'x-session-id': 's1' } }), oauth());
    expect(r.url).toBe('https://api.cline.bot/api/v1/chat/completions');
    expect(r.headers.Authorization).toBe('Bearer workos:tok');
    expect(r.headers['X-CLIENT-TYPE']).toBe('cline-cli');
    expect(r.headers['X-Task-ID']).toBe(taskIdOf('s1'));
    expect(r.body.model).toBe('anthropic/claude-sonnet-5');
  });

  it('refuses the protocols Cline has no endpoint for, and a missing account', async () => {
    await expect(run('prepare', chatReq({ protocol: 'anthropic' }), oauth())).rejects.toThrow(/chat completions only/);
    await expect(run('prepare', chatReq(), undefined)).rejects.toThrow(/needs an account/);
  });

  it('sends an API key as a plain Bearer', async () => {
    const r = await run('prepare', chatReq(), JSON.stringify({ type: 'api', key: 'sk-9' }));
    expect(r.headers.Authorization).toBe('Bearer sk-9');
  });

  it('pins DeepSeek only when the option is on (off by default)', async () => {
    const req = chatReq({ model: 'cline-pass/deepseek-v4-pro', body: { model: 'cline-pass/deepseek-v4-pro' } });
    expect((await run('prepare', req, oauth())).body.providerOptions).toBeUndefined();
    expect((await run('prepare', req, oauth(), { config: { pinUpstream: true } })).body.providerOptions).toEqual({ gateway: { only: ['deepseek'] } });
  });

  it('renews a token near its end, saves the rotated pair, and remembers it against the spent one', async () => {
    const calls = [];
    const fetch = async ({ url, body }) => {
      calls.push({ url, body: JSON.parse(body) });
      return env({ accessToken: 'new', refreshToken: 'ref-new-1', expiresAt: new Date(inMin(60)).toISOString(), userInfo: { clineUserId: 'u1' } });
    };
    const near = oauth({ access: 'old', refresh: 'ref-spent-1', expires: inMin(2) });
    const r = await run('prepare', chatReq(), near, { fetch });
    expect(r.headers.Authorization).toBe('Bearer workos:new');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.cline.bot/api/v1/auth/refresh');
    expect(calls[0].body).toEqual({ refreshToken: 'ref-spent-1', grantType: 'refresh_token' });
    expect(accountSecret()).toMatchObject({ access: 'new', refresh: 'ref-new-1', accountId: 'acc' });
    // the store still says the spent pair: the held one is used, no second spend
    const again = await run('prepare', chatReq(), near, { fetch });
    expect(again.headers.Authorization).toBe('Bearer workos:new');
    expect(calls).toHaveLength(1);
  });

  it('keeps a still-good token through a transient refresh failure; an expired one is the sign-in gone', async () => {
    const down = async () => json('down', 500);
    const good = oauth({ refresh: 'ref-t-1', expires: inMin(2) });
    expect((await run('prepare', chatReq(), good, { fetch: down })).headers.Authorization).toBe('Bearer workos:tok');
    const dead = oauth({ refresh: 'ref-t-2', expires: Date.now() - 1000 });
    await expect(run('prepare', chatReq(), dead, { fetch: down })).rejects.toThrow(/Cline request failed/);
    const revoked = async () => json({ error: 'invalid_grant' }, 400);
    await expect(run('prepare', chatReq(), oauth({ refresh: 'ref-t-3', expires: inMin(1) }), { fetch: revoked })).rejects.toThrow(/sign-in lapsed/);
  });

  it('spends one refresh token once for concurrent callers', async () => {
    let n = 0;
    const fetch = async () => {
      n++;
      return env({ accessToken: 'c', refreshToken: 'ref-c-new', expiresAt: new Date(inMin(60)).toISOString() });
    };
    const near = oauth({ refresh: 'ref-c-1', expires: inMin(1) });
    const [a, b] = await Promise.all([run('prepare', chatReq(), near, { fetch }), run('prepare', chatReq(), near, { fetch })]);
    expect(a.headers.Authorization).toBe(b.headers.Authorization);
    expect(n).toBe(1);
  });
});

describe('refresh', () => {
  const answer = async () => env({ accessToken: 'n2', refreshToken: 'ref-r-new', expiresAt: new Date(inMin(60)).toISOString() });
  it('renews even a token the clock calls good, and reports a refused refresh as expired', async () => {
    expect(await run('refresh', null, oauth({ refresh: 'ref-r-1' }), { fetch: answer })).toBe('renewed');
    expect(accountSecret().access).toBe('n2');
    expect(await run('refresh', null, oauth({ refresh: 'ref-r-2' }), { fetch: async () => json({ error: 'invalid_grant' }, 400) })).toBe('expired');
    expect(await run('refresh', null, JSON.stringify({ type: 'oauth', access: 'x', refresh: '', expires: inMin(60) }), { fetch: answer })).toBe('expired');
  });
});

describe('usage', () => {
  it('maths: dollars, balances, credits shapes, limits', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(1.5)).toBe('$1.50');
    expect(usd(0.005)).toBe('$0.005');
    expect(balanceUSD({ balance: 2_500_000 })).toBe('$2.50');
    expect(balanceUSD({ balance: '500000' })).toBe('$0.50');
    expect(balanceUSD({ balance: -1 })).toBeNull();
    expect(balanceUSD({})).toBeNull();
    expect([compactNumber(3), compactNumber(3.456), compactNumber(2.5), compactNumber(NaN)]).toEqual(['3', '3.46', '2.5', '0']);
    expect(timeOf({ a: 1_700_000_000 }, ['a'])).toBe(new Date(1_700_000_000_000).toISOString());
    expect(timeOf({ a: '2030-01-01T00:00:00Z' }, ['b', 'a'])).toBe('2030-01-01T00:00:00.000Z');
    expect(timeOf({}, ['a'])).toBe('');
    expect(creditsOf({ total: 100, used: 25 }).window).toEqual({ name: 'Credits', used: 25, limit: 100, amount: 25, display: '25 / 100' });
    expect(creditsOf({ data: { total: 200, remaining: 150 } }).window).toEqual({ name: 'Credits', used: 25, limit: 200, amount: 50, display: '50 / 200' });
    expect(creditsOf({ total: 10, remaining: 20 })).toEqual({});
    expect(creditsOf({ credits: 12 })).toEqual({ balance: '12 credits' });
    expect(creditsOf({ used: '4' })).toEqual({ window: { name: 'Credits', used: 0, aside: true, display: '4 credits used' } });
    expect(creditsOf(null)).toEqual({});
    const w = limitWindows({
      limits: [
        { type: 'monthly', percentUsed: 150, resetsAt: '2030-01-01T00:00:00Z' },
        { type: 'five_hour', percentUsed: '12' },
        { type: 'bogus', percentUsed: 1 },
        { type: 'weekly', percentUsed: 'x' },
      ],
    });
    expect(w.map((x) => [x.name, x.used])).toEqual([
      ['5 hours', 12],
      ['Weekly', 0],
      ['Month', 100],
    ]);
    expect(w[0].span).toBe(5 * 3600);
    const u = usageOf({ planName: 'Pro' }, { balance: 1_000_000 }, { limits: [{ type: 'weekly', percentUsed: 5 }] });
    expect([u.plan, u.balance, u.windows.length]).toEqual(['Pro', '$1.00', 1]);
    expect(usageOf(null, { credits: 7 }, null).balance).toBe('7 credits');
  });

  const routes =
    (map) =>
    async ({ url }) => {
      const k = Object.keys(map).find((p) => url.endsWith(p));
      return k ? (map[k].status ? map[k] : env(map[k])) : json('no', 404);
    };

  it('reads the balance and the limits together; no ClinePass (404) is quiet', async () => {
    const map = { '/users/me': { clineUserId: 'u9', plan: 'Free' }, '/users/u9/balance': { balance: 3_000_000 }, '/users/me/plan/usage-limits': { limits: [{ type: 'five_hour', percentUsed: 10 }] } };
    const out = await run('usage', null, oauth(), { fetch: routes(map) });
    expect([out.balance, out.plan, out.windows[0].name, out.user]).toEqual(['$3.00', 'Free', '5 hours', 'acc']);
    delete map['/users/me/plan/usage-limits'];
    const quiet = await run('usage', null, oauth(), { fetch: routes(map) });
    expect(quiet.error).toBeUndefined();
    expect(quiet.windows).toEqual([]);
  });

  it('says so when the limits cannot be read, keeping the balance', async () => {
    const out = await run('usage', null, oauth(), {
      fetch: async ({ url }) => (url.endsWith('usage-limits') ? json('boom', 500) : env(url.endsWith('/users/me') ? { clineUserId: 'u9' } : { balance: 1_000_000 })),
    });
    expect(out.error).toBe("ClinePass limits couldn't be read (HTTP 500: boom)");
    expect(out.balance).toBe('$1.00');
  });

  it('flags a lapsed sign-in', async () => {
    const out = await run('usage', null, oauth(), { fetch: async () => json('denied', 401) });
    expect(out.expired).toBe(true);
    expect(out.windows).toEqual([]);
  });
});

describe('models', () => {
  it('prettifies ids and bundles a snapshot', () => {
    expect(prettify('anthropic/claude-sonnet-5.5')).toBe('Claude Sonnet 5.5');
    expect(prettify('openai/gpt-6-astra')).toBe('GPT 6 Astra');
    expect(prettify('cline-free/mimo-v2.6-flash')).toBe('MiMo V2.6 Flash');
    expect(DEFAULT_MODELS[0].id).toBe('anthropic/claude-sonnet-5.5');
    expect(DEFAULT_MODELS.find((m) => m.id === 'cline-free/mimo-v2.6-flash').name).toBe('MiMo V2.6 Flash (free)');
    expect(DEFAULT_MODELS.find((m) => m.id === 'cline-pass/glm-5.3').name).toBe('GLM 5.3 (ClinePass)');
    expect(tokens('x', 0, '1000.7')).toBe(1000);
    expect(tokens(null)).toBeUndefined();
  });

  it('parses the three groups; a model in two keeps the stronger gate; bad ids are dropped', () => {
    const ms = parseFeed({
      recommended: ['anthropic/claude-sonnet-5', { id: 'cline-free/a-b', name: 'A B' }, 'bare', 5, { id: 'x/y', display_name: 'y' }],
      free: [{ id: 'cline-free/a-b', displayName: 'Free A B' }],
      clinePass: ['cline-pass/z'],
      clineCloud: ['left/out'],
      description: 'not a model',
    });
    const by = Object.fromEntries(ms.map((m) => [m.id, m]));
    expect(Object.keys(by)).toEqual(['anthropic/claude-sonnet-5', 'cline-free/a-b', 'x/y', 'cline-pass/z']);
    expect(by['cline-free/a-b'].name).toBe('Free A B (free)');
    expect(by['cline-pass/z'].name).toBe('Z (ClinePass)');
    expect(by['x/y'].name).toBe('Y');
    expect(parseFeed(null)).toEqual([]);
  });

  const feed =
    (rec, catalog) =>
    async ({ url }) =>
      url.endsWith('/recommended-models') ? rec : catalog;

  it("merges the catalog's windows, recommended first; the catalog is optional, the feed is not", async () => {
    const fetch = feed(
      env({ recommended: ['anthropic/claude-sonnet-5'], free: ['cline-free/m'] }),
      json({
        data: [{ id: 'anthropic/claude-sonnet-5', context_length: 200000, max_completion_tokens: 64000 }, { id: 'bare-id', name: 'Bare', top_provider: { context_length: '8000' } }, { id: '' }],
      }),
    );
    const ms = await run('models', null, undefined, { fetch });
    expect(ms).toEqual([
      { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', protocol: 'chat', context: 200000 },
      { id: 'cline-free/m', name: 'M (free)', protocol: 'chat' },
      { id: 'bare-id', name: 'Bare', protocol: 'chat', context: 8000 },
    ]);
    const noCatalog = await run('models', null, undefined, { fetch: feed(env({ recommended: ['a/b'] }), json('x', 500)) });
    expect(noCatalog.map((m) => m.id)).toEqual(['a/b']);
  });

  it('falls back to the last good list, then to the bundled snapshot, when the feed fails', async () => {
    const down = { fetch: async () => json('x', 500) };
    const last = [{ id: 'old/model', protocol: 'chat' }];
    expect(await run('models', null, undefined, { ...down, storage: { models: last } })).toEqual(last);
    expect((await run('models', null, undefined, down))[0].id).toBe('anthropic/claude-sonnet-5.5');
    expect((await run('models', null, undefined, { fetch: async () => json({ data: {} }) })).length).toBe(DEFAULT_MODELS.length);
  });
});

describe('sign-in flow', () => {
  const workos =
    (replies) =>
    async ({ url, body }) => {
      if (url.endsWith('/authorize/device'))
        return json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://v.example/x', verification_uri_complete: 'https://v.example/x?c=ABCD-1234', interval: 1, expires_in: 300 });
      if (url.endsWith('/user_management/authenticate')) return json(replies.shift());
      if (url.endsWith('/auth/register')) {
        const sent = JSON.parse(body);
        return env({
          accessToken: 'acc-' + sent.accessToken,
          refreshToken: 'ref-' + sent.refreshToken,
          expiresAt: new Date(inMin(60)).toISOString(),
          userInfo: { clineUserId: 'u7', email: 'me@x.io', name: 'Me' },
        });
      }
      return json('no', 404);
    };

  it('shows the code, polls WorkOS (pending, slow_down), trades the tokens and adds the account', async () => {
    const replies = [{ error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'wt', refresh_token: 'wr' }];
    const view = await mount(signIn, { permissions: PERMS, fetch: workos(replies) });
    expect(view.find('Button').props.label).toBe('signIn.browser');
    const effects = await view.press('start');
    expect(view.host.flushed[0]).toMatchObject({ step: 'approve', code: 'ABCD-1234', url: 'https://v.example/x?c=ABCD-1234' });
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const acc = globalThis.__astraTestHost.accounts.get('cline').get('me@x.io');
    expect(acc).toMatchObject({ key: 'me@x.io', displayName: 'me@x.io', email: 'me@x.io', status: 'active' });
    expect(JSON.parse(acc.secret)).toMatchObject({ type: 'oauth', access: 'acc-wt', refresh: 'ref-wr', uid: 'u7' });
  });

  it('says why a refused sign-in failed and stays open', async () => {
    const view = await mount(signIn, { permissions: PERMS, fetch: workos([{ error: 'access_denied', error_description: 'no' }]) });
    const effects = await view.press('start');
    expect(effects.some((e) => e.type === 'close')).toBe(false);
    expect(view.state.error).toMatch(/access_denied \(no\)/);
    expect(view.find('Alert').props.message).toMatch(/access_denied/);
  });

  it('stores a pasted API key as its own account', async () => {
    const view = await mount(signIn, { permissions: PERMS });
    await view.press('toKey');
    expect(view.find('PasswordField')).toBeTruthy();
    await view.change('apiKey', ' sk-cl-1 ');
    const effects = await view.press('saveKey');
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const [acc] = [...globalThis.__astraTestHost.accounts.get('cline').values()];
    expect(JSON.parse(acc.secret)).toEqual({ type: 'api', key: 'sk-cl-1' });
    expect(acc.key).toMatch(/^api-[0-9a-f]{12}$/);
  });

  it('refuses an empty key', async () => {
    const view = await mount(signIn, { permissions: PERMS });
    await view.press('toKey');
    const effects = await view.press('saveKey');
    expect(effects.some((e) => e.type === 'close')).toBe(false);
    expect(globalThis.__astraTestHost.accounts.get('cline')?.size ?? 0).toBe(0);
  });
});

describe('prepare for a caller that did not ask for a stream', () => {
  it('asks Cline for a stream (with usage) so the reply block can frame it; a streaming caller is left alone', async () => {
    const quiet = await run('prepare', chatReq({ stream: false, body: { model: 'm', messages: [], stream: false, stream_options: { x: 1 } } }), oauth());
    expect(quiet.body).toMatchObject({ stream: true, stream_options: { x: 1, include_usage: true } });
    const loud = await run('prepare', chatReq({ body: { model: 'm', messages: [], stream: true } }), oauth());
    expect(loud.body).toEqual({ model: 'm', messages: [], stream: true });
    expect(chatBody({ model: 'm' }, false, false).stream).toBe(true);
  });
});

describe('reply', () => {
  const sse = (o) => ({ data: typeof o === 'string' ? o : JSON.stringify(o), ...(typeof o === 'string' ? {} : { json: o }) });
  const chunk = (delta, extra = {}) => ({
    id: 'gen-1',
    object: 'chat.completion.chunk',
    created: 5,
    model: 'anthropic/claude-sonnet-5',
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  });
  const frames = [
    sse(chunk({ role: 'assistant', content: '' })),
    sse(chunk({ content: 'Hel' })),
    sse(chunk({ content: 'lo', reasoning: 'hm' })),
    sse(chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"a"' } }] })),
    sse(chunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] })),
    sse({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    sse({ id: 'gen-1', choices: [], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }),
    sse('[DONE]'),
  ];
  const go = (frames, request = {}, response = {}) =>
    runResponse(plugin, 'cline', { framing: 'sse', frames, request: { protocol: 'chat', stream: true, model: 'm', ...request }, response }, { permissions: PERMS });

  it('passes a streaming reply through chunk by chunk (the host adds its own [DONE])', async () => {
    const out = await go(frames);
    expect(out.failure).toBeNull();
    expect(out.frames).toHaveLength(7);
    expect(out.frames[1].choices[0].delta.content).toBe('Hel');
    expect(out.frames.includes('[DONE]')).toBe(false);
  });

  it('takes the {data} envelope off a chunk', async () => {
    const out = await go([sse({ data: chunk({ content: 'x' }) })]);
    expect(out.frames).toEqual([chunk({ content: 'x' })]);
  });

  it('folds the stream into one chat.completion for a caller that did not ask for one', async () => {
    const out = await go(frames, { stream: false });
    expect(out.failure).toBeNull();
    expect(out.body).toEqual({
      id: 'gen-1',
      object: 'chat.completion',
      created: 5,
      model: 'anthropic/claude-sonnet-5',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello', reasoning: 'hm', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"a":1}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    });
    // (the SDK harness overwrites a $error from end with its own one-body check for stream:false; the host reports the plugin's message)
    expect((await go([], { stream: false })).failure.status).toBe(502);
    const err = await go([sse({ error: { code: 429, message: 'slow' } })], { stream: false });
    expect(err.failure).toEqual({ status: 429, message: 'slow' });
  });

  it("re-maps Cline's refusals: a ClinePass entitlement is 403, an empty account 429, a lapsed sign-in 401", async () => {
    const r = (status, body) => go([], {}, { status, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) });
    expect((await r(403, { error: { code: 'ENTITLEMENT_ERROR', message: 'Error 403: no' } })).error.status).toBe(403);
    const credits = (await r(402, { error: { code: 'insufficient_credits', current_balance: 0.5, buy_credits_url: 'https://buy' } })).error;
    expect(credits.status).toBe(429);
    expect(credits.message).toBe('out of credits ($0.50): top up at https://buy');
    expect((await r(402, '')).error.message).toMatch(/\$0\.00\): top up at https:\/\/app\.cline\.bot\/credits/);
    expect((await r(401, 'x')).error).toEqual({ status: 401, message: 'the sign-in lapsed: sign in again' });
    expect((await r(403, 'Token expired')).error.status).toBe(401);
    expect((await r(403, 'forbidden: tokens exceeded')).error.status).toBe(403);
    expect((await r(500, { error: { message: 'boom' } })).error).toEqual({ status: 500, message: 'boom' });
    expect((await r(400, { message: 'spend limit reached' })).error.status).toBe(429);
    expect(failure(200, '').status).toBe(502);
  });
});
