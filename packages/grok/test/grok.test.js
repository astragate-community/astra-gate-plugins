import { beforeEach, describe, expect, it } from 'vitest';
import { mount, runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin, { signIn } from '../src/main.js';
import { CLIENT_ID } from '../src/constants.js';
import { cpaAuth, parseImport } from '../src/import.js';
import { DEFAULT_MODELS, listModels, windowsOf } from '../src/models.js';
import { forgetEndpoints, pollDevice, refreshGrant, startDevice } from '../src/oidc.js';
import { modelOf, outgoing, rewrite, signHeaders } from '../src/request.js';
import { SignInExpired, fresh, latest, renew, renewed, renewing } from '../src/session.js';
import { objectRoot } from '../src/tools.js';
import { cardsOf, usage } from '../src/usage.js';
import { limited, rateWindow, resetOf } from '../src/ratelimit.js';

const PERMS = ['providers', 'ui', 'net:https://cli-chat-proxy.grok.com', 'net:https://auth.x.ai'];
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });
const raw = (body, status = 200) => ({ status, headers: {}, body });
const jwtOf = (claims) => 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
const form = (body) => Object.fromEntries(new URLSearchParams(body));
const cred = (o = {}) => ({ key: 'K0', refresh: 'R0', expires: Date.now() + 3600e3, email: 'a@b.c', userId: 'u1', clientId: CLIENT_ID, ...o });
const tokenAnswer = (access, refresh, extra = {}) => json({ access_token: access, refresh_token: refresh, expires_in: 3600, ...extra });

const host = () => globalThis.__astraTestHost;
// the in-memory host's fetch, pointed at a queue (or a function by request); every call is recorded. The issuer's
// discovery document answers 404 unless the test says otherwise, so the known endpoints are used.
function fake(...replies) {
  const calls = [];
  const h = host();
  h.granted = new Set(PERMS);
  h.accounts = new Map();
  h.fetch = async (req) => {
    calls.push(req);
    if (req.url.endsWith('/.well-known/openid-configuration')) return raw('', 404);
    return typeof replies[0] === 'function' ? replies[0](req) : replies.shift();
  };
  return calls;
}
beforeEach(() => {
  renewed.clear();
  renewing.clear();
  forgetEndpoints();
});

describe('request shaping', () => {
  it("drops tools Grok refuses and strips what it can't read, leaving the original alone", () => {
    const body = {
      tools: [{ type: 'function', name: 'a' }, { type: 'custom', name: 'apply_patch' }, { type: 'web_search', external_web_access: true }],
      tool_choice: { type: 'custom' },
      input: [{ type: 'reasoning', content: null, encrypted_content: 'x' }],
    };
    const out = rewrite(body);
    expect(out.tools).toEqual([{ type: 'function', name: 'a' }, { type: 'web_search' }]);
    expect('tool_choice' in out).toBe(false);
    expect('content' in out.input[0]).toBe(false);
    expect(body.tools).toHaveLength(3);
    expect(body.input[0].content).toBeNull();
  });

  it('leaves a body it has nothing to change as it came', () => {
    const body = { tools: [{ type: 'function', name: 'a', parameters: { type: 'object' } }] };
    expect(rewrite(body)).toBe(body);
    expect(rewrite(undefined)).toBeUndefined();
    expect(rewrite(null)).toBeNull();
  });

  it('turns a plain agent_message into a user message', () => {
    const item = { type: 'agent_message', author: 'a', recipient: 'b', content: [{ type: 'input_text', text: 'hi' }] };
    const out = rewrite({ input: [item, { type: 'agent_message', encrypted_content: 's', content: [] }] });
    expect(out.input[0]).toEqual({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'From a to b\n\n' }, { type: 'input_text', text: 'hi' }] });
    expect(out.input[1].type).toBe('agent_message');
  });

  it("folds a function's union parameters, in either tool shape", () => {
    const parameters = { anyOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }] };
    const flat = rewrite({ tools: [{ type: 'function', name: 'f', parameters }] });
    expect(flat.tools[0].parameters).toMatchObject({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] });
    const nested = rewrite({ tools: [{ type: 'function', function: { name: 'f', parameters } }] });
    expect(nested.tools[0].function.parameters.type).toBe('object');
    expect(parameters.anyOf).toBeTruthy();
  });

  it('folds a union at the root into one object', () => {
    const ps = {
      anyOf: [{ type: 'object', properties: { id: { type: 'string' }, a: { type: 'number' } }, required: ['id', 'a'] }, { $ref: '#/$defs/b' }],
      $defs: { b: { type: 'object', properties: { id: { type: 'string' }, b: { type: 'string' } }, required: ['id'] } },
    };
    const out = objectRoot(ps);
    expect(out.type).toBe('object');
    expect(Object.keys(out.properties).sort()).toEqual(['a', 'b', 'id']);
    expect(out.required).toEqual(['id']);
    expect('anyOf' in out).toBe(false);
    expect(ps.anyOf).toBeTruthy();
    const plain = { type: 'object', properties: {} };
    expect(objectRoot(plain)).toBe(plain);
  });

  it('reads the window an id names', () => {
    expect(modelOf('grok-4.7')).toEqual({ model: 'grok-4.7', window: 0 });
    expect(modelOf('grok-4.7@500k')).toEqual({ model: 'grok-4.7', window: 500000 });
    expect(modelOf('grok-4.7@131072')).toEqual({ model: 'grok-4.7', window: 131072 });
    expect(modelOf(undefined)).toEqual({ model: undefined, window: 0 });
  });

  it('signs as the CLI and sends the plain model with its window', () => {
    const body = { model: 'grok-4.7@500k', prompt_cache_key: 'conv1' };
    const { headers, body: sent } = outgoing(body, 'KEY');
    expect(headers).toMatchObject({
      authorization: 'Bearer KEY', 'x-xai-token-auth': 'xai-grok-cli', 'x-grok-model-override': 'grok-4.7', 'x-grok-context-window': '500000', 'x-grok-conv-id': 'conv1',
      'x-grok-client-identifier': 'grok-shell', 'x-grok-client-mode': 'headless',
    });
    expect(sent.model).toBe('grok-4.7');
    expect(body.model).toBe('grok-4.7@500k');
    expect(signHeaders('K')['user-agent']).toMatch(/^grok-shell\/\d+\.\d+\.\d+ \(/);
    expect(outgoing({ model: 'grok-4.7' }, 'K').headers['x-grok-context-window']).toBeUndefined();
  });
});

describe('models', () => {
  it('offers each listed context window beside the default', () => {
    const out = windowsOf({ id: 'grok-4.7', name: 'Grok 4.7', context_window: 256000, context_windows: [256000, 500000, 131072] }, ['high']);
    expect(out.map((m) => [m.id, m.name, m.context])).toEqual([
      ['grok-4.7', 'Grok 4.7', 256000],
      ['grok-4.7@500k', 'Grok 4.7 @ 500k', 500000],
      ['grok-4.7@131072', 'Grok 4.7 @ 131072', 131072],
    ]);
    expect(out[0]).toMatchObject({ protocol: 'responses', vision: true, reasoning: true });
    expect(windowsOf({ id: 'm', context_window: 8000 }, [])).toHaveLength(1);
    expect(windowsOf({ id: 'm', context_window: 8000 }, [])[0].reasoning).toBe(false);
  });

  it("lists the account's Responses models", async () => {
    const calls = fake(json({ data: [{ id: 'grok-4.7', name: 'Grok 4.7', context_window: 256000, reasoning_efforts: [{ value: 'high' }, { value: 'low' }] }, { id: 'chatty', api_backend: 'chat' }] }));
    const out = await listModels('tok');
    expect(calls[0].url).toBe('https://cli-chat-proxy.grok.com/v1/models');
    expect(calls[0].headers.authorization).toBe('Bearer tok');
    expect(out).toEqual([{ id: 'grok-4.7', name: 'Grok 4.7', protocol: 'responses', context: 256000, vision: true, reasoning: true }]);
  });

  it('treats a 401, a failure and an empty list as no list', async () => {
    fake(raw('', 401));
    await expect(listModels('tok')).rejects.toThrow(/sign-in has expired/);
    fake(raw('boom', 500));
    await expect(listModels('tok')).rejects.toThrow(/Grok models: 500/);
    fake(json({ data: [] }));
    await expect(listModels('tok')).rejects.toThrow(/no models/);
  });
});

describe('usage', () => {
  it('reads the weekly credits and the on-demand cap', () => {
    const end = '2030-01-08T00:00:00Z';
    const cards = cardsOf({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end }, creditUsagePercent: 42, onDemandCap: { val: 200 }, onDemandUsed: { val: 50 } } });
    expect(cards).toEqual([{ name: '7 days', used: 42, span: 604800, resetsAt: end }, { name: 'On-demand', used: 25, resetsAt: end, aside: true }]);
    expect(cardsOf({})).toEqual([{ name: 'Allowance', used: 0 }]);
    expect(cardsOf({ config: { billingPeriodEnd: 'garbage' } })).toEqual([{ name: 'Allowance', used: 0 }]);
  });

  it('asks the billing page, and words its failures', async () => {
    const calls = fake(json({ config: { creditUsagePercent: 3 } }));
    expect(await usage('K')).toEqual({ windows: [{ name: 'Allowance', used: 3 }] });
    expect(calls[0].url).toBe('https://cli-chat-proxy.grok.com/v1/billing?format=credits');
    expect(calls[0].headers.authorization).toBe('Bearer K');
    fake(raw('', 503));
    expect(await usage('K')).toEqual({ error: 'Grok billing: HTTP 503', windows: [] });
    fake(raw('<html>'));
    expect((await usage('K')).error).toMatch(/^Grok billing:/);
  });
});

describe('importing a sign-in', () => {
  const claims = (c) => jwtOf(c);
  const cpa = (o = {}) => ({
    type: 'xai', auth_kind: 'oauth', disabled: false, sub: 'u', email: 'a@b.c', refresh_token: 'r',
    access_token: claims({ iss: 'https://auth.x.ai', aud: [CLIENT_ID] }), last_refresh: '2030-01-01T00:00:00Z', expired: '2030-01-02T00:00:00Z', ...o,
  });

  it('accepts only an enabled xAI OAuth CPA account for Grok Build', () => {
    const auth = cpaAuth(cpa());
    expect(auth.expires_at).toBe('2030-01-02T00:00:00.000Z');
    expect(auth.user_id).toBe('u');
    expect(() => cpaAuth(cpa({ disabled: true }))).toThrow(/not an enabled/);
    expect(() => cpaAuth(cpa({ email: '' }))).toThrow(/missing its tokens/);
    expect(() => cpaAuth(cpa({ expired: 'nope' }))).toThrow(/timestamps/);
    expect(() => cpaAuth(cpa({ access_token: claims({ iss: 'other' }) }))).toThrow(/not for the Grok Build/);
  });

  it('reads a CPA file, an auth.json and one of its entries as a credential', () => {
    expect(parseImport(JSON.stringify(cpa()))).toEqual({ key: cpa().access_token, refresh: 'r', expires: Date.parse('2030-01-02T00:00:00Z'), email: 'a@b.c', userId: 'u', clientId: CLIENT_ID });
    const entry = { key: 'kb', refresh_token: 'rb', expires_at: '2030-01-02T00:00:00Z', email: 'e@x', user_id: 'ub', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'cid' };
    const want = { key: 'kb', refresh: 'rb', expires: Date.parse('2030-01-02T00:00:00Z'), email: 'e@x', userId: 'ub', clientId: 'cid' };
    expect(parseImport(JSON.stringify({ z: { nokey: 1 }, a: entry }))).toEqual(want);
    expect(parseImport(JSON.stringify(entry))).toEqual(want);
  });

  it('refuses what cannot be renewed or is not xAI', () => {
    expect(() => parseImport('nope')).toThrow(/not valid JSON/);
    expect(() => parseImport('[]')).toThrow(/JSON object/);
    expect(() => parseImport('{"a":{"nokey":1}}')).toThrow(/no sign-in/);
    expect(() => parseImport(JSON.stringify({ key: 'k' }))).toThrow(/no refresh token/);
    expect(() => parseImport(JSON.stringify({ key: 'k', refresh_token: 'r', oidc_issuer: 'https://evil.example' }))).toThrow(/not from xAI/);
  });
});

describe('xAI sign-in server', () => {
  it('reads the standard device answer, with the known endpoints when discovery fails', async () => {
    const calls = fake(json({ device_code: 'D', user_code: 'U', verification_uri: 'https://auth.x.ai/device', verification_uri_complete: 'https://auth.x.ai/device?c=U', expires_in: 100, interval: 2 }));
    const d = await startDevice();
    expect(calls.at(-1).url).toBe('https://auth.x.ai/oauth2/device/code');
    expect(form(calls.at(-1).body)).toMatchObject({ client_id: CLIENT_ID, scope: 'openid profile email offline_access' });
    expect(d).toMatchObject({ deviceCode: 'D', userCode: 'U', url: 'https://auth.x.ai/device?c=U', intervalMs: 2000 });
    expect(d.deadline).toBeGreaterThan(Date.now() + 99000);
  });

  it('uses the discovery document, but only endpoints at the issuer', async () => {
    const h = host();
    h.granted = new Set(PERMS);
    const urls = [];
    h.fetch = async ({ url }) => {
      urls.push(url);
      if (url.endsWith('/.well-known/openid-configuration')) return json({ device_authorization_endpoint: 'https://auth.x.ai/other/device', token_endpoint: 'https://evil.example/token' });
      return json({ device_code: 'D', user_code: 'U', verification_uri: 'https://auth.x.ai/d' });
    };
    await startDevice();
    expect(urls.at(-1)).toBe('https://auth.x.ai/other/device');
  });

  it('refuses an incomplete or failed answer', async () => {
    fake(json({ user_code: 'U', verification_uri: 'https://v' }));
    await expect(startDevice()).rejects.toThrow(/invalid_device_authorization_response/);
    fake(json({ error: 'invalid_client' }, 400));
    await expect(startDevice()).rejects.toThrow(/invalid_client \(HTTP 400\)/);
  });

  const device = (o = {}) => ({ deviceCode: 'D', intervalMs: 0, deadline: Date.now() + 5000, ...o });
  const sleep = async () => {};

  it('waits through pending, then returns the credential with who the account is', async () => {
    const calls = fake(json({ error: 'authorization_pending' }, 400), tokenAnswer(jwtOf({ email: 'e@x', sub: 'u9' }), 'R'));
    const c = await pollDevice(device(), sleep);
    expect(c).toMatchObject({ refresh: 'R', email: 'e@x', userId: 'u9', clientId: CLIENT_ID });
    expect(form(calls.at(-1).body)).toMatchObject({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'D', client_id: CLIENT_ID });
  });

  it('slows down, gives a slice back with the device still good, and ends on refusal or deadline', async () => {
    fake(json({ error: 'slow_down' }, 400));
    const d = device({ intervalMs: 1 });
    expect(await pollDevice(d, sleep, 3000)).toBeNull();
    expect(d.intervalMs).toBe(5001);
    fake(json({ error: 'access_denied' }, 400));
    await expect(pollDevice(device(), sleep)).rejects.toThrow(/turned down/);
    fake(json({ error: 'expired_token' }, 400));
    await expect(pollDevice(device(), sleep)).rejects.toThrow(/expired/);
    await expect(pollDevice(device({ deadline: Date.now() - 1 }), sleep)).rejects.toThrow(/expired/);
  });

  it('refreshes with the refresh token, keeping who the account is and the old refresh token when none is sent', async () => {
    const calls = fake(json({ access_token: 'K1', expires_in: 60 }));
    const c = await refreshGrant(cred({ refresh: 'R-old' }));
    expect(form(calls.at(-1).body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'R-old', client_id: CLIENT_ID });
    expect(c).toMatchObject({ key: 'K1', refresh: 'R-old', email: 'a@b.c', userId: 'u1' });
  });
});

describe('keeping the sign-in fresh', () => {
  const save = async () => true;

  it('uses a token far from its end as is', async () => {
    const calls = fake();
    const r = await fresh(async () => cred(), save);
    expect([r.cred.key, r.renewed, calls.length]).toEqual(['K0', false, 0]);
  });

  it('refreshes a token near its end once and saves it', async () => {
    const calls = fake(tokenAnswer('K1', 'R1'));
    const saved = [];
    const near = cred({ refresh: 'R-near', expires: Date.now() + 60e3 });
    const keep = async (c) => (saved.push(c), true);
    const [x, y] = await Promise.all([fresh(async () => near, keep), fresh(async () => near, keep)]);
    const spent = () => calls.filter((c) => c.url.endsWith('/oauth2/token'));
    expect(spent()).toHaveLength(1);
    expect([x.cred.key, y.cred.key, x.renewed]).toEqual(['K1', 'K1', true]);
    expect(saved).toHaveLength(1);
    expect(saved[0].refresh).toBe('R1');
    // a later request reading the old credential joins the refresh rather than spending the token again
    expect((await fresh(async () => near, keep)).cred.key).toBe('K1');
    expect(spent()).toHaveLength(1);
  });

  it('follows renewals, and lets go a saved one after a minute', async () => {
    fake(tokenAnswer('K1', 'R1'));
    const a = cred({ refresh: 'R-chain', expires: 0 });
    await renew(a, save);
    expect(latest(a).key).toBe('K1');
    const done = renewed.get('R-chain');
    done.at = Date.now() - 61000;
    expect(latest(a).key).toBe('K0');
    done.saved = false;
    expect(latest(a).key).toBe('K1');
  });

  it('signs out on invalid_grant; another failure keeps the token in hand', async () => {
    const near = cred({ refresh: 'R-bad', expires: Date.now() + 60e3 });
    fake(json({ error: 'invalid_grant' }, 400));
    await expect(fresh(async () => near, save)).rejects.toSatisfy((e) => e instanceof SignInExpired && e.signIn === 'expired');
    renewed.clear();
    fake(json({ error: 'server_error' }, 500));
    expect((await fresh(async () => ({ ...near, refresh: 'R-bad2' }), save)).cred.key).toBe('K0');
    renewed.clear();
    fake(json({ error: 'server_error' }, 500));
    await expect(fresh(async () => ({ ...near, refresh: 'R-bad3', expires: Date.now() - 1 }), save)).rejects.toSatisfy((e) => e.signIn === 'kept');
  });

  it('is not a sign-out when the refresh token was spent elsewhere and the new one is stored', async () => {
    fake(json({ error: 'invalid_grant' }, 400));
    let reads = 0;
    const getAuth = async () => (++reads === 1 ? cred({ refresh: 'R-old', expires: Date.now() + 60e3 }) : cred({ key: 'ELSEWHERE', refresh: 'R-else' }));
    expect((await fresh(getAuth, save)).cred.key).toBe('ELSEWHERE');
  });

  it('expires an account with no refresh token with its access token', async () => {
    expect((await fresh(async () => cred({ refresh: '', expires: Date.now() + 60e3 }), save)).cred.key).toBe('K0');
    await expect(fresh(async () => cred({ refresh: '', expires: Date.now() - 1 }), save)).rejects.toBeInstanceOf(SignInExpired);
    await expect(fresh(async () => null, save)).rejects.toThrow(/not signed in/);
  });
});

describe('provider', () => {
  const secretOf = (o) => JSON.stringify(cred(o));
  const run = (what, request, o, fetch = async () => raw('', 500)) =>
    runProvider(plugin, 'grok', what, request, o === null ? null : { key: 'u1', secret: secretOf(o) }, { permissions: PERMS, fetch });
  const req = (extra = {}) => ({ protocol: 'responses', model: 'grok-4.7', path: '/v1/responses', method: 'POST', headers: {}, body: { model: 'grok-4.7@500k', input: [] }, stream: true, ...extra });

  it("sends Responses requests to the backend, signed, with the window's plain model", async () => {
    const p = await run('prepare', req());
    expect(p.url).toBe('https://cli-chat-proxy.grok.com/v1/responses');
    expect(p.headers).toMatchObject({ authorization: 'Bearer K0', 'x-grok-model-override': 'grok-4.7', 'x-grok-context-window': '500000' });
    expect(p.body.model).toBe('grok-4.7');
  });

  it('keeps a sub-path, and sends a body that needs no change as it is', async () => {
    const p = await run('prepare', req({ path: '/v1/responses/compact?x=1', body: { model: 'grok-4.7' } }));
    expect(p.url).toBe('https://cli-chat-proxy.grok.com/v1/responses/compact');
    expect(p.body).toBeUndefined();
  });

  it('refuses another protocol, and a missing account', async () => {
    await expect(run('prepare', req({ protocol: 'chat' }))).rejects.toThrow(/Responses/);
    await expect(run('prepare', req(), null)).rejects.toThrow(/not signed in/);
  });

  it('renews a token near its end and saves the new credential on the account', async () => {
    const p = await run('prepare', req(), { refresh: 'R-prep', expires: Date.now() + 60e3 }, async () => tokenAnswer('K7', 'R7'));
    expect(p.headers.authorization).toBe('Bearer K7');
    expect(JSON.parse(host().accounts.get('grok').get('u1').secret)).toMatchObject({ key: 'K7', refresh: 'R7' });
  });

  it('fails the request and marks the account when xAI signed it out', async () => {
    await expect(run('prepare', req(), { refresh: 'R-gone', expires: Date.now() + 60e3 }, async () => json({ error: 'invalid_grant' }, 400))).rejects.toThrow(/expired/);
    expect(host().accounts.get('grok').get('u1').status).toBe('expired');
  });

  it("lists the account's models, or the built-in one", async () => {
    expect(await run('models', null, null)).toEqual(DEFAULT_MODELS);
    expect(await run('models', null, {})).toEqual(DEFAULT_MODELS);
    const live = await run('models', null, {}, async () => json({ data: [{ id: 'grok-4.7', context_window: 256000 }] }));
    expect(live.map((m) => m.id)).toEqual(['grok-4.7']);
  });

  it('renews after a 401, says expired for a signed-out account, nothing for a passing failure', async () => {
    expect(await run('refresh', null, { refresh: 'R-401' }, async () => tokenAnswer('K5', 'R5'))).toBe('renewed');
    expect(JSON.parse(host().accounts.get('grok').get('u1').secret)).toMatchObject({ key: 'K5' });
    expect(await run('refresh', null, { refresh: '' })).toBe('expired');
    expect(await run('refresh', null, { refresh: 'R-out' }, async () => json({ error: 'invalid_grant' }, 400))).toBe('expired');
    expect(await run('refresh', null, { refresh: 'R-pass' }, async () => json({ error: 'server_error' }, 500))).toBeNull();
  });

  it("tells the allowance, and the sign-in's state", async () => {
    expect(await run('usage', null, {}, async () => json({ config: { creditUsagePercent: 9 } }))).toEqual({ windows: [{ name: 'Allowance', used: 9 }], signIn: 'kept' });
    const gone = await run('usage', null, { refresh: '', expires: Date.now() - 1 });
    expect(gone).toMatchObject({ windows: [], signIn: 'expired' });
  });
});

describe('sign-in flow', () => {
  const open = (fetch) => mount(signIn, { permissions: PERMS, fetch });
  const device = ({ url }) =>
    url.endsWith('/device/code') ? json({ device_code: 'D', user_code: 'ABCD', verification_uri_complete: 'https://auth.x.ai/d?c=ABCD', interval: 1, expires_in: 60 }) : null;
  const notFound = () => raw('', 404);

  it('shows the code, waits, and adds the account', async () => {
    let polls = 0;
    const view = await open(async (req) => {
      if (req.url.endsWith('/.well-known/openid-configuration')) return notFound();
      if (device(req)) return device(req);
      return ++polls < 2 ? json({ error: 'authorization_pending' }, 400) : tokenAnswer(jwtOf({ email: 'me@x', sub: 'u5' }), 'R');
    });
    expect(view.find('Button').props.label).toBe('signIn.start');
    const effects = await view.press('start');
    expect(effects.some((e) => e.type === 'openExternal')).toBe(true);
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    expect(host().flushed[0].device.userCode).toBe('ABCD');
    const account = host().accounts.get('grok').get('u5');
    expect(account).toMatchObject({ displayName: 'me@x', email: 'me@x', status: 'active' });
    expect(JSON.parse(account.secret)).toMatchObject({ refresh: 'R', email: 'me@x', userId: 'u5' });
  });

  it('keeps the code on screen when a slice ends unconfirmed, and shows a refusal', async () => {
    let answer = json({ error: 'authorization_pending' }, 400);
    const view = await open(async (req) => (req.url.endsWith('/.well-known/openid-configuration') ? notFound() : device(req) ? { ...device(req), body: { ...device(req).body, interval: 50 } } : answer));
    await view.press('start');
    expect(view.state.device.userCode).toBe('ABCD');
    expect(view.find('Button').props.label).toBe('signIn.continue');
    view.state.device.intervalMs = 1;
    answer = json({ error: 'access_denied' }, 400);
    await view.press('wait');
    expect(view.state.device).toBeNull();
    expect(view.find('Alert').props.message).toMatch(/turned down/);
    expect(host().accounts.size).toBe(0);
  });

  it('imports a pasted sign-in, and refuses a bad one on the field', async () => {
    const view = await open(async () => notFound());
    const entry = { key: 'kb', refresh_token: 'rb', expires_at: '2030-01-02T00:00:00Z', email: 'e@x', user_id: 'ub' };
    const bad = await view.press('import', { values: { json: '{"nope":1}' } });
    expect(bad.some((e) => e.type === 'fail')).toBe(true);
    expect(host().accounts.size).toBe(0);
    const effects = await view.press('import', { values: { json: JSON.stringify({ x: entry }) } });
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    expect(JSON.parse(host().accounts.get('grok').get('ub').secret)).toMatchObject({ key: 'kb', refresh: 'rb', email: 'e@x' });
  });
});

// ---- the reply: the rate limit a 429 names, noted for the usage card; events pass on as they came
describe('reply', () => {
  const acct = { key: 'u1', secret: JSON.stringify(cred()) };
  const reply = (input, request = { protocol: 'responses', model: 'grok-4.7', stream: true }) => runResponse(plugin, 'grok', { framing: 'ndjson', account: acct, request, ...input });
  const text = (...ls) => ls.map((t) => ({ text: t }));
  const events = [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'Hi' },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1 } } },
  ];
  const lines = events.flatMap((e) => [`event: ${e.type}`, 'data: ' + JSON.stringify(e), '']);
  beforeEach(() => limited.clear());

  it('passes the Responses events on as event pairs', async () => {
    const out = await reply({ frames: text(...lines) });
    expect(out.failure).toBeNull();
    expect(out.frames).toEqual(events.map((data) => ({ event: data.type, data })));
  });

  it('passes a one-body reply on, one line or pretty-printed', async () => {
    const body = { id: 'resp_1', object: 'response', status: 'completed', output: [] };
    const request = { protocol: 'responses', model: 'grok-4.7', stream: false };
    expect((await reply({ frames: [{ json: body }] }, request)).body).toEqual(body);
    expect((await reply({ frames: text(...JSON.stringify(body, null, 2).split('\n')) }, request)).body).toEqual(body);
    expect((await reply({ frames: [] }, request)).body).toBeUndefined();
  });

  it('keeps the 429 and the reset it names, and shows a Rate limit window until then', async () => {
    const out = await reply({ frames: [], response: { status: 429, headers: { 'retry-after': '120' }, body: '{"error":"slow"}' } });
    expect(out.error).toBeNull();
    expect(out.status).toBe(429); // the reply itself goes on untouched
    const [w] = rateWindow('u1');
    expect(w).toMatchObject({ name: 'Rate limit', used: 100, aside: true });
    expect(Date.parse(w.resetsAt) - Date.now()).toBeGreaterThan(110_000);
    expect(rateWindow('other')).toEqual([]);
  });

  it('a request that goes through lifts it, and a 429 with no reset holds five minutes', async () => {
    await reply({ frames: [], response: { status: 429, headers: {}, body: '{}' } });
    const [w] = rateWindow('u1');
    expect(Date.parse(w.resetsAt) - Date.now()).toBeGreaterThan(290_000);
    await reply({ frames: text(...lines) });
    expect(rateWindow('u1')).toEqual([]);
  });

  it('reads the reset from a ratelimit header, in epoch seconds or seconds from now', () => {
    const now = 1_700_000_000_000;
    expect(resetOf({ 'x-ratelimit-reset': '30' }, now)).toBe(now + 30_000);
    expect(resetOf({ 'x-ratelimit-reset-requests': '1700000600' }, now)).toBe(1_700_000_600_000);
    expect(resetOf({ 'retry-after': 'Wed, 21 Oct 2037 07:28:00 GMT' }, now)).toBe(Date.parse('Wed, 21 Oct 2037 07:28:00 GMT'));
    expect(resetOf({}, now)).toBe(0);
  });

  it('the usage card carries the Rate limit window after the allowance', async () => {
    await reply({ frames: [], response: { status: 429, headers: { 'retry-after': '60' }, body: '{}' } });
    const card = await runProvider(plugin, 'grok', 'usage', null, acct, { permissions: PERMS, fetch: async () => json({ config: { creditUsagePercent: 0 } }) });
    expect(card.windows.map((w) => w.name)).toEqual(['Allowance', 'Rate limit']);
  });

  it('sends the credentialed calls with redirects refused', async () => {
    const calls = fake(json({ config: { creditUsagePercent: 3 } }));
    await usage('K');
    expect(calls[0].redirect).toBe('error');
  });
});
