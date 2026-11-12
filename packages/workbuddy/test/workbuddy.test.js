import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { mount, runProvider } from '@astragate/plugin-sdk/testing';
import plugin, { checkinDue, checkinPage, importV1, signIn } from '../src/main.js';
import { call, enterpriseHeaders, meter, postMeter } from '../src/api.js';
import { checkinOf } from '../src/checkin.js';
import { liveModels } from '../src/models.js';
import { attend, normalizeToolChoice, withOwnSystem, withSystem } from '../src/request.js';
import { mirrorName } from '../src/session.js';
import { SITES, staticModels } from '../src/sites.js';
import { fitted } from '../src/tools.js';
import { usageOf } from '../src/usage.js';

const manifest = JSON.parse(readFileSync(new URL('../astra.plugin.json', import.meta.url), 'utf8'));
const PERMS = manifest.permissions;
const CN = SITES.workbuddy;
const AI = SITES['workbuddy-ai'];
const FUTURE = () => Date.now() + 3600e3;
const auth = (extra = {}) => ({ access: 'tok', refresh: 'r1', expires: FUTURE(), uid: 'u1', ...extra });
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });

// a fetch that answers from a queue and remembers what it was asked
function fake(...replies) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    const r = typeof replies[0] === 'function' ? replies[0](req) : replies.shift();
    if (!r) return { status: 500, body: {} };
    return r;
  };
  return { calls, fn };
}
// the host the direct (non-provider) calls run against
const useFetch = (fn) => {
  const h = globalThis.__astraTestHost;
  h.fetch = fn;
  h.granted = new Set(PERMS);
};

describe('manifest', () => {
  it('declares both builds with the v1 provider ids and the offline model lists', () => {
    expect(manifest.contributes.providers.map((p) => p.id)).toEqual(['workbuddy', 'workbuddy-ai']);
    expect(manifest.contributes.providers[0].models).toEqual(staticModels(CN));
    expect(manifest.contributes.providers[1].models).toEqual(staticModels(AI));
    expect(manifest.replaces).toEqual([{ v1: '@astragate-community/workbuddy-auth' }]);
  });

  it('puts hy3 and hy3-x of the China build on the Anthropic route; every other model, and the international build, on chat', () => {
    const cn = Object.fromEntries(staticModels(CN).map((m) => [m.id, m.protocol]));
    expect(cn).toMatchObject({ hy3: 'anthropic', 'hy3-x': 'anthropic', 'glm-5.3': 'chat', auto: 'chat', 'deepseek-v4-pro': 'chat' });
    expect(staticModels(AI).every((m) => m.protocol === 'chat')).toBe(true);
    expect(staticModels(CN).find((m) => m.id === 'glm-5.3').reasoning).toBe(true);
    expect(staticModels(CN).find((m) => m.id === 'auto').reasoning).toBe(false);
  });
});

describe('check-in', () => {
  const acct = auth();
  it('a first press is claimed, with credit and streak', async () => {
    const f = fake(json({ code: 0, data: { credit: 100, streak_days: '15' } }));
    useFetch(f.fn);
    expect(await checkinOf(CN, acct)).toEqual({ outcome: 'claimed', credit: 100, streak: 15 });
    expect(f.calls[0].url).toBe('https://copilot.tencent.com/billing/meter/daily-checkin');
    expect(f.calls[0].headers.Authorization).toBe('Bearer tok');
    expect(f.calls[0].headers['X-User-Id']).toBe('u1');
  });

  it('code 10001 is done today, and the streak is asked for', async () => {
    const f = fake(json({ code: 10001 }, 400), json({ code: 0, data: { streak_days: 15, today_credit: 100 } }));
    useFetch(f.fn);
    expect(await checkinOf(AI, acct)).toEqual({ outcome: 'done', credit: 100, streak: 15 });
    expect(f.calls[1].url).toBe('https://www.workbuddy.ai/billing/meter/checkin-activity-status');
  });

  it('done stands when the streak cannot be read', async () => {
    useFetch(fake(json({ code: 10001 }, 400), { status: 500, body: {} }).fn);
    expect(await checkinOf(CN, acct)).toEqual({ outcome: 'done', credit: 0, streak: 0 });
  });

  it('a captcha and a failure say what WorkBuddy said', async () => {
    useFetch(fake(json({ code: 10002, msg: '请完成验证码' }, 400)).fn);
    expect(await checkinOf(CN, acct)).toMatchObject({ outcome: 'captcha', message: '请完成验证码' });
    useFetch(fake(json({ code: 5, msg: 'busy' }, 500)).fn);
    expect(await checkinOf(CN, acct)).toEqual({ outcome: 'failed', message: 'busy' });
  });
});

describe('meter', () => {
  it('an enterprise account sends its enterprise on the meter', async () => {
    const f = fake(json({ code: 0, data: {} }));
    useFetch(f.fn);
    await postMeter(CN, auth({ enterpriseId: ' ent1 ' }), '/billing/meter/x');
    expect(f.calls[0].headers).toMatchObject({ 'X-Enterprise-Id': 'ent1', 'X-Tenant-Id': 'ent1' });
    expect(enterpriseHeaders({})).toEqual({});
  });

  it("throws WorkBuddy's message, else its code, else the status", async () => {
    useFetch(fake(json({ code: 7, msg: 'nope' }, 400)).fn);
    await expect(meter(CN, auth(), '/x')).rejects.toThrow('nope');
    useFetch(fake(json({ code: 7 }, 400)).fn);
    await expect(meter(CN, auth(), '/x')).rejects.toThrow('error 7');
    useFetch(fake({ status: 502, body: 'x' }).fn);
    await expect(meter(CN, auth(), '/x')).rejects.toThrow('Bad Gateway');
  });

  it('call words a refusal with the HTTP status and WorkBuddy code', async () => {
    useFetch(fake(json({ code: 11140, msg: 'restricted' }, 403)).fn);
    await expect(call(CN, 'GET', '/v2/x')).rejects.toMatchObject({ message: 'WorkBuddy: restricted (HTTP 403, code 11140)', said: 'restricted', status: 403 });
  });
});

describe('request shaping', () => {
  it('opens a chat with WorkBuddy\'s own system prompt and mends the spellings it takes', () => {
    const b = withSystem({ max_completion_tokens: 50, messages: [{ role: 'developer', content: 'be brief' }, { role: 'user', content: 'hi' }] });
    expect(b.max_tokens).toBe(50);
    expect(b.max_completion_tokens).toBeUndefined();
    expect(b.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    const bare = withSystem({ messages: [{ role: 'user', content: 'hi' }] });
    expect(bare.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
  });

  it('rewrites the words WorkBuddy refuses a chat for, and drops the billing header block', () => {
    const b = withSystem({
      messages: [
        { role: 'system', content: [{ type: 'text', text: "x-anthropic-billing-header: cc_version=1\n" }, { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }] },
        { role: 'user', content: 'Main branch (you will usually use this for PRs): main' },
      ],
    });
    expect(b.messages[0].content).toEqual([{ type: 'text', text: "You are Claude Code, Anthropic's CLI for Claude." }]);
    expect(b.messages[1].content).toBe('Main branch (usually the base for PRs): main');
  });

  it("moves a Claude Code system prompt into the messages on the Anthropic route, WorkBuddy's own answering in system", () => {
    const b = withOwnSystem({
      system: [{ type: 'text', text: 'You are Claude Code, Anthropic’s official CLI for Claude.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }, { type: 'text', text: 'go' }] }],
    });
    expect(b.system).toBe('You are a helpful assistant.');
    expect(b.messages[0].content.map((p) => p.type)).toEqual(['tool_result', 'text', 'text']);
    expect(b.messages[0].content[1].text).toBe("You are Claude Code, Anthropic's CLI for Claude.");
    expect(b.messages[0].content[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('takes a string system prompt into a new first user message, and leaves any other body as it was', () => {
    const b = withOwnSystem({ system: 'You are Claude Code', messages: [{ role: 'assistant', content: 'x' }] });
    expect(b.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'You are Claude Code' }] });
    const other = { system: 'Be nice', messages: [{ role: 'user', content: 'hi' }] };
    expect(withOwnSystem(structuredClone(other))).toEqual(other);
    expect(withOwnSystem({ messages: [] })).toEqual({ messages: [] });
  });

  it('turns OpenAI\'s tool_choice objects into WorkBuddy\'s strings', () => {
    expect(normalizeToolChoice({ tool_choice: { type: 'function', function: { name: 'Read' } } }).tool_choice).toBe('Read');
    expect(normalizeToolChoice({ tool_choice: { type: 'required' } }).tool_choice).toBe('required');
    expect(normalizeToolChoice({ tool_choice: { type: 'bogus' } })).toEqual({});
    expect(normalizeToolChoice({ tool_choice: 'none', tools: [1], functions: [2] })).toEqual({});
    expect(normalizeToolChoice({ tool_choice: 'auto' }).tool_choice).toBe('auto');
  });

  it('fits tools: names WorkBuddy refuses, NUL patterns, tuple items, object roots', () => {
    const body = {
      tool_choice: { type: 'function', function: { name: 'a.b' } },
      messages: [{ role: 'assistant', tool_calls: [{ function: { name: 'a.b', arguments: '{}' } }] }, { role: 'tool', name: 'a.b', content: '' }],
      tools: [
        { type: 'function', function: { name: 'a.b', parameters: { type: 'object', properties: { p: { type: 'string', pattern: '^a\\0$' }, t: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } } } } },
        { type: 'function', function: { name: 'a_b', parameters: { anyOf: [{ type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }] } } },
        { type: 'function', function: { name: 'ok-name' } },
      ],
    };
    const { body: out, names } = fitted(body);
    expect(out.tools[0].function.name).toBe('a_b_2');
    expect(names.get('a_b_2')).toBe('a.b');
    expect(out.tools[0].function.parameters.properties.p.pattern).toBe('^a\\u0000$');
    expect(out.tools[0].function.parameters.properties.t.items).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] });
    expect(out.tools[1].function.parameters).toMatchObject({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'] });
    expect(out.messages[0].tool_calls[0].function.name).toBe('a_b_2');
    expect(out.messages[1].name).toBe('a_b_2');
    expect(out.tool_choice.function.name).toBe('a_b_2');
  });

  describe('conversation ids', () => {
    const ids = (messages, session = '', had = {}) => {
      const out = {};
      attend(out, had, { messages }, session, 'salt');
      return out;
    };
    const u = (text) => ({ role: 'user', content: text });

    it('gives every step of one send one request id, and the next message another', () => {
      const a = ids([u('hi')], 's1');
      const step = ids([u('hi'), { role: 'assistant', content: '', tool_calls: [{ id: 'c' }] }, { role: 'tool', content: 'r' }], 's1');
      const next = ids([u('hi'), { role: 'assistant', content: 'yo' }, u('more')], 's1');
      expect(step['X-Conversation-Request-ID']).toBe(a['X-Conversation-Request-ID']);
      expect(next['X-Conversation-Request-ID']).not.toBe(a['X-Conversation-Request-ID']);
      expect(next['X-Conversation-ID']).toBe(a['X-Conversation-ID']);
      expect(a['X-Conversation-Message-ID']).toBe(a['X-Request-ID']);
      expect(a['X-Conversation-Message-ID']).not.toBe(step['X-Conversation-Message-ID']);
    });

    it("in Anthropic's shape a tool's result is not a new send", () => {
      const a = ids([u('hi')]);
      const step = ids([u('hi'), { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] }]);
      expect(step['X-Conversation-Request-ID']).toBe(a['X-Conversation-Request-ID']);
    });

    it('keeps the ids the caller sent, and names no conversation when there is nothing to name it by', () => {
      const out = ids([u('hi')], '', { 'x-conversation-id': 'mine', 'x-conversation-request-id': 'mine' });
      expect(out['X-Conversation-ID']).toBeUndefined();
      expect(out['X-Conversation-Request-ID']).toBeUndefined();
      expect(ids([{ role: 'system', content: 's' }])['X-Conversation-ID']).toBeUndefined();
    });
  });
});

describe('provider', () => {
  const req = (protocol, extra = {}) => ({ protocol, model: 'glm-5.3', path: '/v1/x', method: 'POST', headers: { 'x-session-id': 'sess' }, body: { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true }, stream: true, ...extra });
  const prepare = (id, r, a = { key: 'u1', secret: JSON.stringify(auth()) }, opts = {}) => runProvider(plugin, id, 'prepare', r, a, { permissions: PERMS, ...opts });

  it('sends a chat to the build\'s /v2 route with the account\'s identity and the chat route\'s mending', async () => {
    const out = await prepare('workbuddy', req('chat', { body: { model: 'glm-5.3', max_completion_tokens: 9, tool_choice: 'none', tools: [{}], messages: [{ role: 'user', content: 'hi' }], stream: true } }));
    expect(out.url).toBe('https://copilot.tencent.com/v2/chat/completions');
    expect(out.headers).toMatchObject({ Authorization: 'Bearer tok', 'X-User-Id': 'u1', 'X-Domain': 'copilot.tencent.com', 'X-IDE-Name': 'WorkBuddy', 'User-Agent': 'WorkBuddy/5.5.6' });
    expect(out.headers['X-Agent-Type']).toBeUndefined();
    expect(out.headers['X-Conversation-ID']).toMatch(/^[0-9a-f]{32}$/);
    expect(out.body.max_tokens).toBe(9);
    expect(out.body.tools).toBeUndefined();
    expect(out.body.messages[0].role).toBe('system');
    const ai = await prepare('workbuddy-ai', req('chat'));
    expect(ai.url).toBe('https://www.workbuddy.ai/v2/chat/completions');
    expect(ai.headers['X-Agent-Type']).toBe('main');
    expect(ai.headers['X-Domain']).toBe('www.workbuddy.ai');
  });

  it('sends the enterprise an enterprise account signed in as', async () => {
    const out = await prepare('workbuddy', req('chat'), { key: 'u1', secret: JSON.stringify(auth({ enterpriseId: 'e9' })) });
    expect(out.headers).toMatchObject({ 'X-Enterprise-Id': 'e9', 'X-Tenant-Id': 'e9' });
  });

  it('sends an Anthropic request to /v1/messages, keeping the query, with the chat mending left out', async () => {
    const body = { model: 'hy3', system: 'You are Claude Code', tools: [{ name: 'x', input_schema: {} }], max_completion_tokens: 5, messages: [{ role: 'user', content: 'hi' }] };
    const out = await prepare('workbuddy', req('anthropic', { path: '/v1/messages?beta=true', body }));
    expect(out.url).toBe('https://copilot.tencent.com/v1/messages?beta=true');
    expect(out.body.system).toBe('You are a helpful assistant.');
    expect(out.body.max_completion_tokens).toBe(5); // chat's spelling fix is not applied
    expect(out.body.tools).toEqual(body.tools);
  });

  it('refuses a protocol a build has no route for, and a request with no account', async () => {
    await expect(prepare('workbuddy', req('responses'))).rejects.toThrow(/responses/);
    await expect(prepare('workbuddy-ai', req('anthropic'))).rejects.toThrow(/anthropic/);
    await expect(prepare('workbuddy', req('chat'), null)).rejects.toThrow(/no account/);
  });

  it('refreshes a token about to end and keeps the new tokens on the account and in the plugin\'s copy', async () => {
    const f = fake(json({ code: 0, data: { accessToken: 'new', refreshToken: 'r2', expiresIn: 3600 } }));
    const old = auth({ access: 'old', refresh: 'r-spend-1', expires: Date.now() + 1000 });
    const out = await prepare('workbuddy', req('chat'), { key: 'u1', secret: JSON.stringify(old) }, { fetch: f.fn });
    expect(f.calls[0].url).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh');
    expect(f.calls[0].headers['X-Refresh-Token']).toBe('r-spend-1');
    expect(out.headers.Authorization).toBe('Bearer new');
    const h = globalThis.__astraTestHost;
    const saved = JSON.parse(h.accounts.get('workbuddy').get('u1').secret);
    expect(saved).toMatchObject({ access: 'new', refresh: 'r2', uid: 'u1' });
    expect(JSON.parse(h.secrets.get(mirrorName(CN, 'u1')))).toMatchObject({ access: 'new', refresh: 'r2' });
  });

  it('uses the token it has when the refresh fails', async () => {
    const old = auth({ access: 'old', refresh: 'r-spend-2', expires: Date.now() + 1000 });
    const out = await prepare('workbuddy', req('chat'), { key: 'u1', secret: JSON.stringify(old) }, { fetch: fake(json({ code: 5, msg: 'x' }, 500)).fn });
    expect(out.headers.Authorization).toBe('Bearer old');
  });

  it('says an account that holds no sign-in is signed out', async () => {
    await expect(prepare('workbuddy', req('chat'), { key: 'u1', secret: 'not json' })).rejects.toThrow(/signed in/);
  });

  it('after a 401, renews with the refresh token and says so; with none, says nothing and never marks the account expired', async () => {
    const f = fake(json({ code: 0, data: { accessToken: 'n2', refreshToken: 'r3' } }));
    const run = (secret, opts) => runProvider(plugin, 'workbuddy', 'refresh', null, { key: 'u1', secret: JSON.stringify(secret) }, { permissions: PERMS, ...opts });
    expect(await run(auth({ refresh: 'r-spend-3' }), { fetch: f.fn })).toBe('renewed');
    expect(await run(auth({ refresh: '' }), { fetch: f.fn })).toBeNull();
    expect(await run(auth({ refresh: 'r-spend-4' }), { fetch: fake(json({ code: 1, msg: 'bad' }, 400)).fn })).toBeNull();
  });
});

describe('models and usage', () => {
  const config = {
    agents: [{ name: 'cli', models: ['m1', 'm2', 'm2-sg', 'bare'] }, { name: 'ide', models: ['other'] }],
    models: [
      { id: 'm1', name: 'M One', maxInputTokens: 1000, maxOutputTokens: 100, supportsImages: true, reasoning: { supportedEfforts: ['low'] } },
      { id: 'm2', name: 'Same', supportsImages: false },
      { id: 'm2-sg', name: 'Same' },
    ],
  };
  const models = (id, secret, fetch) => runProvider(plugin, id, 'models', null, secret === null ? null : { key: 'u1', secret: JSON.stringify(secret) }, { permissions: PERMS, fetch });

  it("lists the account's own models from WorkBuddy's config, telling alike names apart", async () => {
    const f = fake(json({ code: 0, data: config }));
    const list = await models('workbuddy', auth(), f.fn);
    expect(f.calls[0].url).toBe('https://copilot.tencent.com/v3/config');
    expect(f.calls[0].headers['User-Agent']).toBe('CLI/2.0.0 WorkBuddy/5.5.6');
    expect(list).toEqual([
      { id: 'm1', name: 'M One', protocol: 'chat', context: 1000, output: 100, vision: true, reasoning: true },
      { id: 'm2', name: 'Same', protocol: 'chat', vision: false },
      { id: 'm2-sg', name: 'Same (SG)', protocol: 'chat', vision: false },
      { id: 'bare', name: 'bare', protocol: 'chat' },
    ]);
  });

  it('says WorkBuddy AI\'s GLM models take no images whatever its config says, and hy3 speaks Anthropic', async () => {
    const list = await liveModelsOf(AI, { agents: [{ name: 'cli', models: ['glm-5.3', 'gpt-5.5'] }], models: [{ id: 'glm-5.3', supportsImages: true }, { id: 'gpt-5.5', supportsImages: true }] });
    expect(list.map((m) => m.vision)).toEqual([false, true]);
    const cn = await liveModelsOf(CN, { agents: [{ name: 'cli', models: ['hy3'] }], models: [] });
    expect(cn[0].protocol).toBe('anthropic');
  });
  async function liveModelsOf(site, cfg) {
    useFetch(fake(json({ code: 0, data: cfg })).fn);
    return liveModels(site, auth());
  }

  it('falls back to the offline list with no account, a failing config or an empty one', async () => {
    expect((await models('workbuddy', null)).map((m) => m.id)).toContain('hy3');
    expect(await models('workbuddy-ai', auth(), fake({ status: 500, body: {} }).fn)).toEqual(staticModels(AI));
    expect(await models('workbuddy', auth(), fake(json({ code: 0, data: { agents: [] } })).fn)).toEqual(staticModels(CN));
  });

  it("tells the plan's credits and when they run out", async () => {
    const sum = { Packages: [{ PackageCode: 'P1', CycleTotalCapacity: '100', CycleUsedCapacity: '25.5' }] };
    const end = Date.now() + 86400e3;
    const f = fake(
      json({ code: 0, data: sum }),
      json({ code: 0, data: { Accounts: [{ PackageCode: 'P1', CycleCapacityRemain: '74.5', DeductionEndTime: end }], TotalCount: 1 } }),
      json({ code: 0, data: { Accounts: [], TotalCount: 0 } }),
    );
    const out = await runProvider(plugin, 'workbuddy', 'usage', null, { key: 'u1', secret: JSON.stringify(auth()) }, { permissions: PERMS, fetch: f.fn });
    expect(f.calls[0].url).toBe('https://copilot.tencent.com/billing/meter/get-user-resource-summary');
    expect(out.plan).toBe('Free');
    expect(out.windows).toHaveLength(1);
    expect(out.windows[0]).toMatchObject({ name: 'Credits', used: 25.5, display: '25.5 / 100', amount: 25.5, limit: 100, unit: 'credits', runsOut: 74.5, runsOutAt: new Date(end).toISOString() });
  });

  it("falls back to an enterprise account's meter when the summary has no packages", async () => {
    const f = fake(json({ code: 0, data: {} }), json({ code: 0, data: { limitNum: '200', credit: '50', cycleStartTime: '2026-11-01 00:00:00', cycleResetTime: '2026-12-01 00:00:00' } }));
    const out = await runProvider(plugin, 'workbuddy', 'usage', null, { key: 'u1', secret: JSON.stringify(auth()) }, { permissions: PERMS, fetch: f.fn });
    expect(out.plan).toBe('Enterprise');
    expect(out.windows[0]).toMatchObject({ used: 25, display: '50 / 200', resetsAt: '2026-11-30T16:00:00.000Z' });
  });

  it('usageOf names a paid plan Pro, and rejects a capacity it cannot read', () => {
    expect(usageOf({ IsPaidUser: true, Packages: [] }).plan).toBe('Pro');
    expect(() => usageOf({ Packages: [{ CycleTotalCapacity: 'abc' }] })).toThrow(/ParseFloat/);
  });
});

describe('sign-in flow', () => {
  const state = { code: 0, data: { state: 'st1', authUrl: 'https://copilot.tencent.com/login?x=1' } };
  const token = { code: 0, data: { accessToken: 'A', refreshToken: 'R', expiresIn: 3600, domain: 'copilot.tencent.com' } };
  const who = { code: 0, data: { uid: 'u7', nickname: 'Ann', enterpriseId: ' ' } };
  const open = (params, fetch) => mount(signIn, { params, permissions: PERMS, fetch });

  it('asks which build when none is named', async () => {
    const view = await open({}, fake().fn);
    expect(view.findAll('Button').map((b) => b.props.label)).toEqual(['signIn.site.workbuddy', 'signIn.site.workbuddy-ai']);
  });

  it('opens the page, polls until WorkBuddy gives the token and the account, then adds it and closes', async () => {
    const replies = [json(state), json({ code: 11217, msg: 'not yet' }, 400), json(token), json({ code: 12151, msg: 'wait' }, 400), json(who)];
    const f = fake(...replies);
    const view = await open({ provider: 'plugin2-astragate-community-workbuddy-workbuddy' }, f.fn);
    const effects = await view.press('start', { site: 'workbuddy' });
    expect(f.calls[0].url).toBe('https://copilot.tencent.com/v2/plugin/auth/state?platform=workbuddy');
    const open_ = effects.find((e) => e.type === 'openExternal');
    expect(open_.url).toBe('https://copilot.tencent.com/login?x=1&version=2.0.0&loginSessionId=' + new URL(open_.url).searchParams.get('loginSessionId'));
    expect(f.calls[2].url).toContain('/v2/plugin/auth/token?state=st1');
    expect(f.calls[4].headers.Authorization).toBe('Bearer A');
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const account = globalThis.__astraTestHost.accounts.get('workbuddy').get('u7');
    expect(account.displayName).toBe('Ann');
    expect(JSON.parse(account.secret)).toMatchObject({ access: 'A', refresh: 'R', uid: 'u7', domain: 'copilot.tencent.com' });
    expect(globalThis.__astraTestHost.secrets.has(mirrorName(CN, 'u7'))).toBe(true);
  });

  it('picks the international build from a provider id, and renews the account a second sign-in names', async () => {
    const f = fake(json(state), json(token), json(who));
    const view = await open({ provider: 'workbuddy-ai' }, f.fn);
    await view.press('start', { site: 'workbuddy-ai' });
    expect(f.calls[0].url).toContain('https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy-ai');
    expect([...globalThis.__astraTestHost.accounts.get('workbuddy-ai').keys()]).toEqual(['u7']);
  });

  it('shows the failure and offers another try', async () => {
    const view = await open({ provider: 'workbuddy' }, fake(json({ code: 0, data: {} })).fn);
    const effects = await view.press('start', { site: 'workbuddy' });
    expect(effects.some((e) => e.type === 'close')).toBe(false);
    expect(view.find('Alert').props.message).toMatch(/no sign-in page/);
    expect(view.find('Button').props.label).toBe('signIn.retry');
  });

  it("refuses a sign-in page that isn't https", async () => {
    const view = await open({ provider: 'workbuddy' }, fake(json({ code: 0, data: { state: 's', authUrl: 'http://evil.example/x' } })).fn);
    await view.press('start', { site: 'workbuddy' });
    expect(view.find('Alert').props.message).toMatch(/isn't https/);
  });
});

describe('check-in page and upgrade', () => {
  it('lists the accounts of both builds and presses their check-ins', async () => {
    const f = fake(json({ code: 0, data: { credit: 10, streak_days: 2 } }), json({ code: 10001 }, 400), json({ code: 0, data: {} }));
    const view = await mount(checkinPage, { permissions: PERMS, fetch: f.fn });
    expect(view.find('EmptyState')).toBeTruthy();
    const h = globalThis.__astraTestHost;
    h.accounts.set('workbuddy', new Map([['u1', { key: 'u1', displayName: 'Ann' }]]));
    h.accounts.set('workbuddy-ai', new Map([['u2', { key: 'u2' }]]));
    h.secrets.set(mirrorName(CN, 'u1'), JSON.stringify(auth()));
    h.secrets.set(mirrorName(AI, 'u2'), JSON.stringify(auth({ uid: 'u2' })));
    await view.press('all');
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://copilot.tencent.com/billing/meter/daily-checkin',
      'https://www.workbuddy.ai/billing/meter/daily-checkin',
      'https://www.workbuddy.ai/billing/meter/checkin-activity-status',
    ]);
    const stored = await view.storage.get('checkin');
    expect(stored['workbuddy|u1']).toMatchObject({ outcome: 'claimed', credit: 10, streak: 2 });
    expect(stored['workbuddy-ai|u2'].outcome).toBe('done');
    expect(view.findAll('Row')).toHaveLength(2);
  });

  it('the job presses each account once per Beijing day, and retries a failure only after 30 minutes', async () => {
    const f = fake(json({ code: 5, msg: 'busy' }, 500), json({ code: 0, data: { credit: 1, streak_days: 1 } }));
    const view = await mount(checkinPage, { permissions: PERMS, fetch: f.fn });
    const h = globalThis.__astraTestHost;
    h.accounts.set('workbuddy', new Map([['u1', { key: 'u1' }]]));
    h.secrets.set(mirrorName(CN, 'u1'), JSON.stringify(auth()));
    expect(await checkinDue()).toBe(1); // fails
    expect(await checkinDue()).toBe(0); // too soon to retry
    const all = await view.storage.get('checkin');
    h.storage.set('checkin', JSON.stringify({ 'workbuddy|u1': { ...all['workbuddy|u1'], at: Date.now() - 31 * 60e3 } }));
    expect(await checkinDue()).toBe(1); // retried: claimed
    expect(await checkinDue()).toBe(0); // done for today
    expect(f.calls).toHaveLength(2);
  });

  it("takes over a v1 browser sign-in, but not one that used WorkBuddy desktop's file", async () => {
    globalThis.__astraTestHost.accounts = new Map();
    globalThis.__astraTestHost.granted = new Set(PERMS);
    const n = await importV1({
      workbuddy: { type: 'oauth', access: 'a1', refresh: 'r1', expires: 5, uid: 'u1', accountId: 'Ann', domain: 'd', enterpriseId: 'e1' },
      'workbuddy-ai#2': { type: 'oauth', access: 'a2', refresh: 'r2', uid: 'u2', accountId: 'Bob' },
      'workbuddy#3': { type: 'oauth', source: 'desktop', access: '', refresh: '', uid: 'u3' },
      other: { type: 'oauth', access: 'x' },
    });
    expect(n).toBe(2);
    const h = globalThis.__astraTestHost;
    expect([...h.accounts.get('workbuddy').keys()]).toEqual(['u1#e1']);
    expect(JSON.parse(h.accounts.get('workbuddy').get('u1#e1').secret)).toMatchObject({ access: 'a1', refresh: 'r1', enterpriseId: 'e1', domain: 'd' });
    expect(h.accounts.get('workbuddy-ai').get('u2').displayName).toBe('Bob');
  });
});
