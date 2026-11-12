import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount, runProvider } from '@astragate/plugin-sdk/testing';
import plugin, { signInCn, signInGlobal } from '../src/main.js';
import { chatModel, chooseModels, devModel, maxModel, modelsOf, fallbackModels } from '../src/models.js';
import { SITES, accountOf, authHostOf, traeHost } from '../src/sites.js';
import { credits, dollarUsageOf, round, usageCard } from '../src/usage.js';
import { jwtExp, queryOf, whenOf, parseJSON } from '../src/values.js';
import { errorOf } from '../src/errors.js';
import { authorizationUrl, CALLBACK } from '../src/signin.js';

const cn = SITES['trae-cn'];
const global = SITES['trae-global'];
const messages = { en: JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')), zh: JSON.parse(readFileSync(new URL('../locales/zh.json', import.meta.url), 'utf8')) };
const manifest = JSON.parse(readFileSync(new URL('../astra.plugin.json', import.meta.url), 'utf8'));
const PERMS = manifest.permissions;

const NOW = Date.now();
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (seconds = 3600) => 'h.' + b64url({ exp: Math.floor(NOW / 1000) + seconds }) + '.s';
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });
const stored = (o = {}) => JSON.stringify({ token: jwt(), refresh: 'R1', expires: NOW + 3600_000, uid: 'u1', name: 'alice', clientId: 'ono9krqynydwx5', deviceId: '1234567890123456789', machineId: 'abcd', ...o });
const entry = (id, o = {}) => ({ config_name: id, display_name: id.toUpperCase(), model_detail_list: [{ model_name: id + '__dev', max_tokens: 8000 }], context_window_tokens: { dev: 100_000 }, ...o });

// a run of one provider call, with an account whose sign-in is stored (or not)
const run = (site, what, { auth, fetch, request = null, config, storage } = {}) =>
  runProvider(plugin, site.id, what, request, { key: 'u1', secret: 'u1' }, { permissions: PERMS, messages, fetch, config, storage, secrets: auth ? { [`auth:${site.id}:u1`]: auth } : {} });

describe('values', () => {
  it('reads expiry times: seconds, milliseconds, ISO, nothing', () => {
    expect(whenOf(1_700_000_000)).toBe(1_700_000_000_000);
    expect(whenOf('1700000000')).toBe(1_700_000_000_000);
    expect(whenOf(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(whenOf('2026-01-01T00:00:00Z')).toBe(Date.parse('2026-01-01T00:00:00Z'));
    for (const v of [undefined, null, '', 'nope', 0, -3, NaN]) expect(whenOf(v)).toBe(0);
  });

  it('reads a JWT exp without atob or Buffer, and loose JSON', () => {
    expect(jwtExp(jwt(100))).toBe(Math.floor(NOW / 1000) * 1000 + 100_000);
    expect(jwtExp('not.a.jwt')).toBe(0);
    expect(parseJSON('{"a":1}')).toEqual({ a: 1 });
    expect(parseJSON('"text"')).toEqual({});
    expect(parseJSON(undefined)).toEqual({});
  });

  it('reads the query of a pasted address', () => {
    const q = queryOf('http://127.0.0.1:58472/authorize?userJwt=%7B%22Token%22%3A%22T%22%7D&refreshToken=a+b&x#frag');
    expect(q.get('userJwt')).toBe('{"Token":"T"}');
    expect(q.get('refreshToken')).toBe('a b');
    expect(q.get('x')).toBe('');
    expect(queryOf('refreshToken=R').get('refreshToken')).toBe('R');
    expect(queryOf('http://127.0.0.1:58472/authorize').size).toBe(0);
    expect(queryOf(undefined).size).toBe(0);
  });

  it('reads the error shapes Trae answers with', () => {
    expect(errorOf({ ResponseMetadata: { Error: { Code: 'c', Message: 'bad' } } })).toEqual({ code: 'c', message: 'bad' });
    expect(errorOf({ error: { code: 4008, message: 'quota' } })).toEqual({ code: 4008, message: 'quota' });
    expect(errorOf('{"code":1001,"message":"x"}')).toEqual({ code: 1001, message: 'x' });
  });
});

describe('hosts', () => {
  it('takes only a plain https host on Trae\'s domains', () => {
    expect(traeHost(' https://api.trae.cn/ ')).toBe('https://api.trae.cn');
    expect(traeHost('https://x.trae.ai/p/q/')).toBe('https://x.trae.ai/p/q');
    expect(traeHost('https://a.b.mchost.guru')).toBe('https://a.b.mchost.guru');
    for (const bad of ['http://trae.cn', 'https://trae.cn:8080', 'https://u:p@trae.cn', 'https://trae.cn/?x=1', 'https://nottrae.cn', 'https://evil.com', '', null, 'junk']) expect(traeHost(bad)).toBe('');
    expect(authHostOf('https://tenant.trae.cn', cn)).toBe('https://tenant.trae.cn');
    expect(authHostOf('https://x.trae.ai', cn)).toBe(''); // another realm's
  });

  it('keeps the kind-of-account fields only, never a secret', () => {
    expect(accountOf({ TenantID: 7, enterprise: true, loginType: 'sso', userToken: 'x', sessionTeam: 'y', nested: { a: 1 }, name: 'n', orgName: null })).toEqual({ TenantID: 7, enterprise: true, loginType: 'sso', orgName: null });
  });

  it('picks the model host and usage host per realm and region', () => {
    expect(cn.apiOf({})).toBe('https://trae-api-cn.mchost.guru');
    expect(global.apiOf({})).toBe('https://coresg-normal.trae.ai');
    expect(global.apiOf({ region: 'us-east' })).toBe('https://coreva-normal.trae.ai');
    expect(global.apiOf({ api: 'https://api-us-east.trae.ai' })).toBe('https://coreva-normal.trae.ai');
    expect(global.usage.host(global, { region: 'US' })).toBe('https://api-us-east.trae.ai');
    expect(global.usage.host(global, {})).toBe('https://api-sg-central.trae.ai');
    expect(global.regionOf({ AIRegion: ' US ' })).toBe('US');
    expect(cn.regionOf({ AIRegion: 'US' })).toBe('');
  });

  it('names the device and the callback to the authorization page', () => {
    const url = authorizationUrl(cn, { deviceId: '123', machineId: 'abc' }, 'trace-1');
    expect(url.startsWith('https://www.trae.cn/authorization?')).toBe(true);
    expect(url).toContain('client_id=ono9krqynydwx5');
    expect(url).toContain('device_id=123');
    expect(url).toContain('machine_id=abc');
    expect(url).toContain('hide_saas_login=false');
    expect(url).toContain('auth_callback_url=' + encodeURIComponent(CALLBACK));
    expect(authorizationUrl(global, { deviceId: '1', machineId: 'm' }, 't').startsWith('https://www.trae.ai/authorization?')).toBe(true);
  });

  it('every host the code calls is a net: permission', () => {
    const origins = new Set(PERMS.filter((p) => p.startsWith('net:')).map((p) => p.slice(4)));
    for (const site of [cn, global]) for (const [k, v] of Object.entries(site.hosts)) if (k !== 'web') expect(origins.has(v), v).toBe(true);
  });
});

describe('model lists', () => {
  it('chat models only: not helpers, switched-off configs, custom slots, or (Global) hidden channels', () => {
    expect(chatModel(entry('a'), cn)).toBe(true);
    expect(chatModel(entry('a', { usage: 'summary' }), cn)).toBe(false);
    expect(chatModel(entry('a', { usage: 'chat_completion' }), cn)).toBe(true);
    expect(chatModel(entry('a', { config_switch: false }), cn)).toBe(false);
    expect(chatModel(entry('custom_model_3'), cn)).toBe(false);
    expect(chatModel(entry('a', { is_custom_model: true }), cn)).toBe(false);
    expect(chatModel(entry('a', { display_config: { is_custom_model: true } }), cn)).toBe(false);
    expect(chatModel(entry('a', { is_invisible_to_user: true }), cn)).toBe(true); // Trae CN's lists are served whole
    expect(chatModel(entry('a', { is_invisible_to_user: true }), global)).toBe(false);
    expect(chatModel({}, cn)).toBe(false);
  });

  it('finds the __dev model, and a Max only when its window is bigger', () => {
    const e = entry('m', { model_detail_list: [{ model_name: 'm__dev', max_tokens: 4000 }, { model_name: 'm__max', max_tokens: 64000 }], context_window_tokens: { dev: 100_000, max: 500_000 } });
    expect(devModel(e).model_name).toBe('m__dev');
    expect(maxModel(e)).toEqual({ name: 'm__max', most: 64000, window: 500_000, entry: e });
    expect(maxModel(entry('m', { model_detail_list: e.model_detail_list, context_window_tokens: { dev: 100_000, max: 100_000 } }))).toBeNull();
    expect(maxModel(entry('plain'))).toBeNull();
    const named = entry('m', { model_detail_list: e.model_detail_list, context_window_tokens: undefined });
    expect(maxModel(named, e).window).toBe(500_000); // the __max model from one entry, the window from another's
  });

  it('asks a model several functions list through the entry that names a __dev model', () => {
    const chosen = chooseModels({ chat_v3: [entry('a', { model_detail_list: [] }), entry('b')], solo_agent: [entry('a'), entry('c')] }, cn);
    expect(chosen.map((c) => [c.id, c.fn])).toEqual([['a', 'solo_agent'], ['b', 'chat_v3'], ['c', 'solo_agent']]);
    expect(chosen[0].dev.model_name).toBe('a__dev');
    expect(chosen[0].max).toBeNull();
  });

  it('lets an entry carrying another model\'s name lose to the one the lists agree on', () => {
    const lists = {
      chat_v3: [entry('flash', { display_name: 'Other Name' }), entry('other', { display_name: 'Other Name' })],
      solo_agent: [entry('flash', { display_name: 'Flash' })],
      solo_work_lite: [entry('flash', { display_name: 'Flash' })],
    };
    expect(chooseModels(lists, cn).find((c) => c.id === 'flash').fn).toBe('solo_work_lite');
  });

  it('finds a Max across the functions\' entries, and leaves a list\'s own "-max" entry alone', () => {
    const withMax = entry('m', { model_detail_list: [{ model_name: 'm__dev', max_tokens: 4000 }, { model_name: 'm__max', max_tokens: 64000 }], context_window_tokens: { dev: 100_000, max: 500_000 } });
    const [c] = chooseModels({ chat_v3: [entry('m')], solo_agent: [withMax] }, cn);
    expect(c.max.window).toBe(500_000);
    expect(c.maxFn).toBe('solo_agent');
    expect('max' in chooseModels({ chat_v3: [withMax, entry('m-max')] }, cn).find((x) => x.id === 'm')).toBe(false);
  });

  it('lists a model with its limits, and a Max as a model of its own', () => {
    const withMax = entry('m', { model_detail_list: [{ model_name: 'm__dev', max_tokens: 4000 }, { model_name: 'm__max', max_tokens: 64000 }], context_window_tokens: { dev: 100_000, max: 500_000 } });
    const out = modelsOf(chooseModels({ chat_v3: [entry('p'), withMax] }, cn), cn);
    expect(out.map((m) => m.id)).toEqual(['p', 'm', 'm-max']);
    expect(out[0]).toMatchObject({ name: 'P', protocol: 'chat', context: 100_000, output: 8000, reasoning: true, vision: false });
    expect(out[2]).toMatchObject({ name: 'M (Max)', context: 500_000, output: 64000 });
  });

  it('keeps the fallback list\'s limits where the live entry names none, and the 128K default otherwise', () => {
    const [known, fresh] = modelsOf(chooseModels({ chat_v3: [entry('glm-5.2', { context_window_tokens: undefined, model_detail_list: [] }), entry('y', { context_window_tokens: undefined, model_detail_list: [] })] }, cn), cn);
    expect(known).toMatchObject({ context: 200_000, output: 32_000 });
    expect(fresh).toMatchObject({ context: 128_000 });
    expect('output' in fresh).toBe(false);
  });

  it('has a fallback list of each realm, all chat models that reason', () => {
    expect(fallbackModels(cn).map((m) => m.id)).toEqual(['glm-5.2', 'glm-5', 'kimi-k2.6', 'qwen-3.7-plus', 'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash']);
    expect(fallbackModels(global).find((m) => m.id === 'gemini-3-flash').context).toBe(1_000_000);
    expect(manifest.contributes.providers.map((p) => p.models.map((m) => m.id))).toEqual([cn, global].map((s) => s.models.map((m) => m.id)));
  });
});

describe('provider.models', () => {
  const lists = (fn) => json({ function_configs: [{ function: 'chat_v3', config_info_list: [entry('p')] }, { function: 'solo_agent', config_info_list: [fn] }] });
  const withMax = entry('m', { model_detail_list: [{ model_name: 'm__dev', max_tokens: 4000 }, { model_name: 'm__max', max_tokens: 64000 }], context_window_tokens: { dev: 100_000, max: 500_000 } });

  it('reads the account\'s lists as TRAE SOLO CN asks them', async () => {
    const calls = [];
    const got = await run(cn, 'models', { auth: stored(), fetch: async (c) => (calls.push(c), lists(withMax)) });
    expect(calls[0].url).toBe('https://trae-api-cn.mchost.guru/api/ide/v1/batch_get_detail_param');
    expect(calls[0].headers.Authorization).toMatch(/^Cloud-IDE-JWT /);
    expect(calls[0].headers['x-device-id']).toBe('1234567890123456789');
    expect(JSON.parse(calls[0].body).functions).toEqual(cn.functions);
    expect(got.map((m) => m.id)).toEqual(['p', 'm', 'm-max']);
  });

  it('asks each function when the batch gives none; one failing leaves the others', async () => {
    const byFn = { chat_v3: [entry('a')], solo_agent: [entry('b')] };
    const calls = [];
    const got = await run(cn, 'models', {
      auth: stored(),
      fetch: async (c) => {
        calls.push(c.url);
        if (c.url.includes('batch_')) return json({});
        const fn = JSON.parse(c.body).function;
        return byFn[fn] ? json({ config_info_list: byFn[fn] }) : json({}, 500);
      },
    });
    expect(got.map((m) => m.id)).toEqual(['a', 'b']);
    expect(calls).toHaveLength(1 + cn.functions.length);
  });

  it('falls back to the realm\'s list with no account, no sign-in or a failing page', async () => {
    const ids = (r) => r.map((m) => m.id);
    expect(ids(await runProvider(plugin, 'trae-global', 'models', null, null, { permissions: PERMS }))).toEqual(global.models.map((m) => m.id));
    expect(ids(await run(cn, 'models'))).toEqual(cn.models.map((m) => m.id));
    expect(ids(await run(cn, 'models', { auth: stored(), fetch: async () => json({}, 500) }))).toEqual(cn.models.map((m) => m.id));
  });

  it('marks the account for a new sign-in when Trae turns the token away', async () => {
    const h = globalThis.__astraTestHost;
    const got = await run(cn, 'models', { auth: stored(), fetch: async () => json({ code: 1001 }) });
    expect(got.map((m) => m.id)).toEqual(cn.models.map((m) => m.id));
    expect(h.accounts.get('trae-cn').get('u1').status).toBe('expired');
  });

  it('renews a token near its end first, and keeps the new pair', async () => {
    const h = globalThis.__astraTestHost;
    const calls = [];
    await run(global, 'models', {
      auth: stored({ expires: NOW + 30_000 }),
      fetch: async (c) => {
        calls.push(c.url);
        return c.url.includes('ExchangeToken') ? json({ Result: { Token: jwt(7200), RefreshToken: 'R2' } }) : json({});
      },
    });
    expect(calls[0]).toBe('https://growsg-normal.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken');
    expect(JSON.parse(h.secrets.get('auth:trae-global:u1')).refresh).toBe('R2');
  });
});

describe('provider.refresh', () => {
  const ok = async () => json({ Result: { Token: jwt(60), RefreshToken: 'R2', ClientID: 'c', UserInfo: { ScreenName: 'bob', UserID: 5 } } });

  it('renews with the refresh token as the IDE does, and keeps the new pair', async () => {
    const calls = [];
    expect(await run(cn, 'refresh', { auth: stored(), fetch: async (c) => (calls.push(c), ok()) })).toBe('renewed');
    expect(calls[0].url).toBe('https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken');
    expect(JSON.parse(calls[0].body)).toEqual({ ClientID: 'ono9krqynydwx5', RefreshToken: 'R1', ClientSecret: '-', UserID: '' });
    expect(JSON.parse(globalThis.__astraTestHost.secrets.get('auth:trae-cn:u1')).refresh).toBe('R2');
  });

  it('says expired when the refresh token is spent or there is no sign-in, and nothing for a hiccup', async () => {
    expect(await run(cn, 'refresh', { auth: stored(), fetch: async () => json({ code: 10101, message: 'x' }) })).toBe('expired');
    expect(await run(cn, 'refresh', { auth: stored(), fetch: async () => json({ message: 'refresh token expired' }, 400) })).toBe('expired');
    expect(await run(cn, 'refresh')).toBe('expired');
    expect(await run(cn, 'refresh', { auth: stored(), fetch: async () => json({ message: 'gateway' }, 502) })).toBeNull();
    expect(await run(cn, 'refresh', { auth: stored(), fetch: async () => { throw new Error('offline'); } })).toBeNull();
  });
});

describe('usage', () => {
  const a = { name: 'bob', uid: 'u' };

  it('adds up credit packs: -1 unlimited, the soonest end', () => {
    const pack = (limit, used, end) => ({ entitlement_base_info: { quota: { credits_limit: limit }, end_time: end }, usage: { credits_amount: used } });
    expect(credits({ user_entitlement_pack_list: [pack(100, 30, 1_900_000_000), pack(50, 5, 1_800_000_000), { entitlement_base_info: {} }] })).toEqual({ limit: 150, used: 35, unlimited: false, until: 1_800_000_000_000 });
    expect(credits({ user_entitlement_pack_list: [pack(-1, 0)] }).unlimited).toBe(true);
    expect(credits({})).toEqual({ limit: 0, used: 0, unlimited: false, until: 0 });
  });

  it('reads the dollar billing\'s pack; null with none', () => {
    const v = { user_entitlement_pack_list: [{ display_desc: 'Free', entitlement_base_info: { quota: { basic_usage_limit: 3, bonus_usage_limit: 1 }, end_time: 1_900_000_000 }, usage: { basic_usage_amount: 1, bonus_usage_amount: 0.5 } }] };
    expect(dollarUsageOf(v)).toEqual({ plan: 'Free', basic: 3, bonus: 1, used: 1, usedBonus: 0.5, end: 1_900_000_000_000 });
    expect(dollarUsageOf({})).toBeNull();
    expect(round(1.2345)).toBe(1.23);
  });

  it('makes CN\'s window the credits and Global\'s the dollars', () => {
    const v = { is_credits_billing: true, user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: 200 }, end_time: 1_900_000_000 }, usage: { credits_amount: 50 } }] };
    expect(usageCard(cn, v, a)).toEqual({ plan: 'Credits', user: 'bob', windows: [{ name: 'Credits', used: 25, amount: 50, limit: 200, unit: 'credits', resetsAt: new Date(1_900_000_000_000).toISOString() }] });
    expect(usageCard(cn, { user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: -1 } } }] }, a).balance).toBe('unlimited');
    expect(usageCard(cn, {}, a).plan).toBe('Free');
    const d = { user_entitlement_pack_list: [{ display_desc: 'Pro', entitlement_base_info: { quota: { basic_usage_limit: 3, bonus_usage_limit: 1 } }, usage: { basic_usage_amount: 1 } }] };
    expect(usageCard(global, d, a)).toEqual({ plan: 'Pro', user: 'bob', windows: [{ name: 'Dollar Usage', used: 25, amount: 1, limit: 4, unit: 'usd' }] });
    expect(usageCard(global, {}, a)).toEqual({ error: 'Trae Global usage: no entitlement pack in the answer', user: 'bob' });
  });

  it('asks the page by realm and region, and shows the card', async () => {
    const calls = [];
    const pack = json({ user_entitlement_pack_list: [{ entitlement_base_info: { quota: { basic_usage_limit: 2 } }, usage: {} }] });
    const card = await run(global, 'usage', { auth: stored({ region: 'US' }), fetch: async (c) => (calls.push(c), pack) });
    expect(calls[0].url).toBe('https://api-us-east.trae.ai/trae/api/v1/pay/user_current_entitlement_list');
    expect(card.windows[0].limit).toBe(2);
    await run(global, 'usage', { auth: stored(), fetch: async (c) => (calls.push(c), pack) });
    expect(calls[1].url).toBe('https://api-sg-central.trae.ai/trae/api/v1/pay/user_current_entitlement_list');
    await run(cn, 'usage', { auth: stored(), fetch: async (c) => (calls.push(c), json({})) });
    expect(calls[2].url).toBe('https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage');
    expect(JSON.parse(calls[2].body)).toEqual({ require_usage: true, req_source: 0 });
  });

  it('shows the errors: a lapsed sign-in, Trae\'s message, a bad status, no sign-in', async () => {
    const h = globalThis.__astraTestHost;
    const usage = (fetch, auth = stored()) => run(cn, 'usage', { auth, fetch });
    expect(await usage(async () => json({ code: 1001 }))).toEqual({ error: "alice: Trae CN's sign-in has expired — sign in again", signIn: 'expired' });
    expect(h.accounts.get('trae-cn').get('u1').status).toBe('expired');
    expect(await usage(async () => json({ code: 9, message: 'busy' }))).toMatchObject({ error: 'Trae CN credits: busy', user: 'alice' });
    expect((await usage(async () => json({}, 503))).error).toBe('Trae CN credits: 503 Service Unavailable');
    expect(await run(cn, 'usage', { fetch: async () => json({}) })).toEqual({ signIn: 'expired', error: 'Trae CN: not signed in' });
  });
});

describe('sign-in flow', () => {
  const callback = (extra = {}) => CALLBACK + '?' + new URLSearchParams({ userJwt: JSON.stringify({ Token: 'T', RefreshToken: 'R', TokenExpireAt: 1_900_000_000 }), userInfo: JSON.stringify({ ScreenName: 'bob', UserID: 9, tenant: 't' }), ...extra });
  const open = (view = signInCn, fetch) => mount(view, { permissions: PERMS, messages, fetch });
  const submit = (v, text) => v.press('submit', { values: { callback: text } });
  const accounts = (id) => globalThis.__astraTestHost.accounts.get(id);

  it('opens the realm\'s authorization page with the device it will use', async () => {
    const v = await open();
    expect(v.find('Form')).toBeTruthy();
    expect(v.find('TextArea').props.name).toBe('callback');
    const effects = await v.press('open');
    const url = effects.find((e) => e.type === 'openExternal');
    expect(url).toBeTruthy();
    const target = JSON.stringify(url);
    expect(target).toContain('www.trae.cn/authorization');
    expect(target).toContain(v.state.device.deviceId);
    expect(v.state.device.deviceId).toMatch(/^[1-9][0-9]{18}$/);
    expect(v.state.device.machineId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(await (await open(signInGlobal)).press('open'))).toContain('www.trae.ai/authorization');
  });

  it('signs in from the pasted address: the account, its sign-in kept as a secret', async () => {
    const v = await open();
    const effects = await submit(v, callback());
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const acc = accounts('trae-cn').get('9');
    expect(acc).toMatchObject({ key: '9', displayName: 'bob', status: 'active' });
    const kept = JSON.parse(globalThis.__astraTestHost.secrets.get('auth:trae-cn:9'));
    expect(kept).toMatchObject({ token: 'T', refresh: 'R', uid: '9', name: 'bob', expires: 1_900_000_000_000, deviceId: v.state.device.deviceId, machineId: v.state.device.machineId, account: { tenant: 't' } });
    expect(JSON.stringify(acc)).not.toContain('"T"');
  });

  it('signing in again updates the account, not a second one', async () => {
    const v = await open();
    await submit(v, callback());
    await submit(v, callback());
    expect([...accounts('trae-cn').keys()]).toEqual(['9']);
  });

  it('exchanges a refresh token given alone (the older page)', async () => {
    const calls = [];
    const v = await open(signInGlobal, async (c) => (calls.push(c.url), json({ Result: { Token: 'TX', RefreshToken: 'RX', UserInfo: { ScreenName: 'x', UserID: 1 } } })));
    const effects = await submit(v, CALLBACK + '?refreshToken=R0');
    expect(calls).toEqual(['https://growsg-normal.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken']);
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    expect(JSON.parse(globalThis.__astraTestHost.secrets.get('auth:trae-global:1')).token).toBe('TX');
  });

  it('says what is wrong with an address that carries no sign-in, no token, or an error', async () => {
    const fail = async (text) => (await submit(await open(), text)).find((e) => e.type === 'fail')?.errors?.callback;
    expect(await fail('')).toMatch(/carries no sign-in/);
    expect(await fail(CALLBACK)).toMatch(/carries no sign-in/);
    expect(await fail(CALLBACK + '?userJwt=%7B%7D')).toBe('trae.cn sent back no token');
    expect(await fail(CALLBACK + '?userJwt=' + encodeURIComponent('{"Token":"T"}'))).toBe('trae.cn sent back no refresh token');
    expect(await fail(CALLBACK + '?error=denied&error_description=You%20said%20no')).toBe('You said no');
    expect(accounts('trae-cn')?.size ?? 0).toBe(0);
  });
});

describe('daily check-in', () => {
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const setup = async ({ config = { checkin: true }, storage, fetch, accounts = [{ key: 'u1' }] } = {}) => {
    await run(cn, 'models', { auth: stored(), config, storage, fetch });
    const h = globalThis.__astraTestHost;
    h.accounts.set('trae-cn', new Map(accounts.map((a) => [a.key, a])));
    for (const a of accounts) h.secrets.set('auth:trae-cn:' + a.key, stored({ uid: a.key }));
    h.fetch = fetch;
    return h;
  };
  const job = (h) => h.run({ op: 'job', id: 'checkin' });

  it('asks the status, claims when it is on and today\'s is not in, as the IDE sends it', async () => {
    const calls = [];
    const h = await setup({ fetch: async (c) => (calls.push(c), json(c.url.endsWith('/status') ? { data: { enable: true, checked_in: false, credits: 5 } } : { code: 0, data: { credits: 5 } })) });
    calls.length = 0;
    await job(h);
    expect(calls.map((c) => c.url)).toEqual(['https://api.trae.cn/trae/api/v2/ug/checkin_credits/status', 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim']);
    expect(JSON.parse(calls[0].body)).toEqual({ req_source: 1 });
    expect(calls[0].headers['User-Agent']).toMatch(/TRAE-SOLO-CN\/0\.1\.69 .*Electron/);
    expect(calls[0].headers.Authorization).toMatch(/^Cloud-IDE-JWT /);
    expect(calls[0].headers['x-device-id']).toBe('1234567890123456789');
    expect(h.storage.has('checkin.u1')).toBe(true);
    expect(JSON.parse(h.storage.get('checkin.u1'))).toBe(day);
    calls.length = 0;
    await job(h); // once a day
    expect(calls).toHaveLength(0);
  });

  it('does not claim what is in already, or turned off; code 9095 means this device checked in', async () => {
    const states = [];
    for (const answer of [{ data: { enable: true, checked_in: true } }, { data: { enable: false } }]) {
      const calls = [];
      const h = await setup({ fetch: async (c) => (calls.push(c), json(answer)) });
      calls.length = 0;
      await job(h);
      states.push(calls.length);
    }
    expect(states).toEqual([1, 1]);
    const h = await setup({ fetch: async (c) => json(c.url.endsWith('/status') ? { data: { enable: true, checked_in: false } } : { code: 9095, message: 'done' }) });
    await job(h);
    expect(JSON.parse(h.storage.get('checkin.u1'))).toBe(day);
  });

  it('keeps trying on a failure (9074), marks the account when the token is turned away', async () => {
    const h = await setup({ fetch: async () => json({ code: 9074, message: 'too many' }) });
    await job(h);
    expect(h.storage.has('checkin.u1')).toBe(false);
    expect(h.logs.some((l) => JSON.stringify(l).includes('too many'))).toBe(true);
    h.fetch = async () => json({ code: 1001 });
    await job(h);
    expect(h.accounts.get('trae-cn').get('u1').status).toBe('expired');
  });

  it('does nothing while the setting is off, or for an expired or switched-off account', async () => {
    const calls = [];
    const f = async (c) => (calls.push(c), json({}));
    await job(await setup({ config: { checkin: false }, fetch: f }));
    await job(await setup({ accounts: [{ key: 'a', status: 'expired' }, { key: 'b', enabled: false }], fetch: f }));
    expect(calls.filter((c) => c.url.includes('/ug/'))).toHaveLength(0);
  });
});

describe('locales', () => {
  it('have the same keys and placeholders in zh and en, and every key the code asks for', () => {
    const keys = (o) => Object.keys(o).sort();
    expect(keys(messages.zh)).toEqual(keys(messages.en));
    const holes = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const k of keys(messages.en)) expect(holes(messages.zh[k]), k).toBe(holes(messages.en[k]));
    const src = ['main.js'].map((f) => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')).join('');
    for (const [, k] of src.matchAll(/\bt\('([\w.]+)'/g)) expect(messages.en[k], k).toBeTruthy();
  });
});

describe('manifest', () => {
  it('replaces the v1 package and keeps its provider ids', () => {
    expect(manifest.id).toBe('astragate-community.trae');
    expect(manifest.replaces).toEqual([{ v1: '@astragate-community/trae-auth' }]);
    expect(manifest.contributes.providers.map((p) => p.id)).toEqual(['trae-cn', 'trae-global']);
    expect(manifest.contributes.providers.map((p) => p.signIn.flow)).toEqual(['signInCn', 'signInGlobal']);
  });
});
