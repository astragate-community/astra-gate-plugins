import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { mount, runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin, { signIn } from '../src/main.js';
import { claims, expiry } from '../src/jwt.js';
import { FactoryStatus, orgRefused, refused, vendorError } from '../src/errors.js';
import { CORE, MODELS, manifestModel } from '../src/models.js';
import { dollars, limitWindows, windowEnd } from '../src/usage-windows.js';
import { DROID_LINE, droidBody } from '../src/opening.js';
import { anthropicBody } from '../src/anthropic-request.js';
import { rewrite, rewriteContent } from '../src/rewrite.js';
import { configSkillCompat, modelWording, quotedToolText } from '../src/wording.js';
import { applyTokens, resetCaches } from '../src/session.js';
import { forget, unwrapMessage } from '../src/reply.js';
import { wrapAnthropicTools } from '../src/tools.js';

beforeEach(resetCaches);

const PERMS = ['providers', 'ui', 'legacy.auth:import', 'net:https://api.workos.com', 'net:https://api.factory.ai', 'net:https://api.eu.factory.ai'];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
const secs = (fromNow) => Math.floor(Date.now() / 1000) + fromNow;
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });
const account = (over = {}) => ({ type: 'oauth', access: jwt({ exp: secs(3600) }), refresh: 'r1', expires: Date.now() + 3600e3, orgId: 'org_1', activeOrganizationId: 'org_1', region: '', premBaseHost: '', email: 'a@b.c', ...over });
const nearEnd = () => account({ access: jwt({ exp: secs(30) }), expires: Date.now() + 30e3 });
const stored = (c) => ({ key: 'a@b.c', secret: JSON.stringify(c) });
const heldSecret = () => JSON.parse(globalThis.__astraTestHost.accounts.get('factory').get('a@b.c').secret);

// a fetch that answers from a queue and remembers what it was asked
function queue(...replies) {
  const calls = [];
  const fetch = async (req) => {
    calls.push(req);
    return replies.shift() ?? json({});
  };
  return { calls, opts: { permissions: PERMS, fetch } };
}
const form = (body) => Object.fromEntries(new URLSearchParams(body));

const O = 'responses';
const req = (protocol, body = {}, extra = {}) => ({ protocol, model: body.model ?? null, path: '/v1/x', method: 'POST', headers: {}, body, stream: false, ...extra });
const prepare = (r, c, opts) => runProvider(plugin, 'factory', 'prepare', r, stored(c), opts);

describe('tokens', () => {
  it('reads claims and expiry from a JWT', () => {
    const t = jwt({ exp: 1767225600, email: 'a@b.c' });
    expect(claims(t).email).toBe('a@b.c');
    expect(expiry(t)).toBe(1767225600000);
    expect(expiry('not.a.jwt')).toBe(0);
    expect(claims(undefined)).toEqual({});
    expect(claims(jwt({ name: 'Zoë' })).name).toBe('Zoë');
  });

  it('keeps the old refresh token when none rotated', () => {
    const c = { refresh: 'old' };
    applyTokens(c, { access_token: jwt({ exp: 10 }) });
    expect(c.refresh).toBe('old');
    expect(c.expires).toBe(10000);
    applyTokens(c, { access_token: jwt({ exp: 20 }), refresh_token: 'new' });
    expect(c.refresh).toBe('new');
  });
});

describe('errors', () => {
  it('finds the message wherever Factory put it, else cuts the body', () => {
    expect(vendorError('{"error":{"message":"no"}}', '403 Forbidden')).toBe('no');
    expect(vendorError('{"detail":"d"}', 'x')).toBe('d');
    expect(vendorError('{"errors":[{"message":"first"}]}', 'x')).toBe('first');
    expect(vendorError('<html>', '502 Bad Gateway')).toBe('502 Bad Gateway');
    expect(vendorError('  plain   words ', '500')).toBe('500: plain words');
    expect(vendorError('x'.repeat(400), '500').endsWith('…')).toBe(true);
  });

  it('treats a 4xx but a rate limit as final, and a 403 about the org as the org\'s', () => {
    expect(refused(new FactoryStatus(400, ''))).toBe(true);
    expect(refused(new FactoryStatus(429, ''))).toBe(false);
    expect(refused(new FactoryStatus(500, ''))).toBe(false);
    expect(refused(new Error('x'))).toBe(false);
    expect(orgRefused(403, 'Requested active organization is not accessible by this user')).toBe(true);
    expect(orgRefused(401, 'Requested active organization is not accessible by this user')).toBe(false);
  });
});

describe('models', () => {
  it('lists every droid model in the manifest, as the code knows it', () => {
    const manifest = JSON.parse(readFileSync(new URL('../astra.plugin.json', import.meta.url), 'utf8'));
    expect(manifest.contributes.providers[0].models).toEqual(MODELS.map(manifestModel));
    expect(MODELS.length).toBe(33);
    expect(manifestModel(MODELS.find((m) => m.id === 'glm-5.3'))).toEqual({ id: 'glm-5.3', name: 'GLM-5.3', protocol: 'chat', context: 1040000, output: 131072, reasoning: true });
    expect(manifestModel(MODELS.find((m) => m.id === 'claude-haiku-4-5-20251001'))).toEqual({ id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', protocol: 'anthropic', vision: true, reasoning: true });
  });

  it('counts the open vendors\' models in Droid Core only', () => {
    expect(CORE.includes('glm-5.3') && CORE.includes('kimi-k3')).toBe(true);
    expect(CORE.includes('claude-opus-5') || CORE.includes('gpt-6-sol') || CORE.includes('grok-4.7')).toBe(false);
  });
});

describe('usage windows', () => {
  it('reads a window end as an ISO time or epoch milliseconds, nothing else', () => {
    expect(windowEnd('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(windowEnd('1767225600000')).toBe('2026-01-01T00:00:00.000Z');
    expect(windowEnd(1767225600000)).toBe('2026-01-01T00:00:00.000Z');
    expect(windowEnd('2026-01-01')).toBeUndefined();
    expect(windowEnd(0)).toBeUndefined();
  });

  it('rounds a half cent to even, as Go does', () => {
    expect([dollars(1250), dollars(12.5), dollars(13.5), dollars(0)]).toEqual(['$12.50', '$0.12', '$0.14', '$0.00']);
  });

  it('makes windows: spans, clamped percents, Core\'s own windows and the extra usage balance', () => {
    const windows = limitWindows({
      extraUsageAllowed: true,
      extraUsageBalanceCents: 500,
      limits: {
        standard: { fiveHour: { usedPercent: 12.5, windowEnd: '2026-01-01T00:00:00Z' }, weekly: { usedPercent: 140 }, monthly: { usedPercent: -3 } },
        core: { weekly: { usedPercent: 3 } },
      },
    });
    expect(windows.map((w) => [w.name, w.used, w.span])).toEqual([['5 hours', 12.5, 18000], ['7 days', 100, 604800], ['30 days', 0, 2592000], ['Droid Core · 7 days', 3, 604800], ['Extra usage', 0, undefined]]);
    expect(windows[0].resetsAt).toBe('2026-01-01T00:00:00.000Z');
    expect(windows[0].notModels).toEqual(CORE);
    expect(windows[3].models).toEqual(CORE);
    expect(windows.every((w) => w.aside)).toBe(true);
    expect(windows[4].display).toBe('$5.00');
    const plain = limitWindows({ extraUsageAllowed: true, extraUsageBalanceCents: 0, limits: { standard: { weekly: { usedPercent: 1 } } } });
    expect(plain.length).toBe(1);
    expect(plain[0].aside).toBeUndefined();
  });
});

describe('opening as droid', () => {
  it('opens Responses\' instructions and chat\'s first system message with droid\'s line', () => {
    expect(droidBody('responses', { model: 'gpt-6-sol', instructions: 'be brief', input: [] }).instructions).toBe(DROID_LINE + '\nbe brief');
    expect(droidBody('responses', { input: [] }).instructions).toBe(DROID_LINE);
    expect(droidBody('chat', { messages: [{ role: 'user', content: 'hi' }] }).messages[0]).toEqual({ role: 'system', content: DROID_LINE });
    expect(droidBody('chat', { messages: [{ role: 'system', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }).messages[0].content).toBe(DROID_LINE + '\na\nb');
  });

  it('hands back a request that opens so already, or isn\'t ours, as the same object', () => {
    const opened = { instructions: DROID_LINE + '\nx', input: [] };
    expect(droidBody('responses', opened)).toBe(opened);
    const other = { a: 1 };
    expect(droidBody('gemini', other)).toBe(other);
    const odd = { instructions: 5 };
    expect(droidBody('responses', odd)).toBe(odd);
  });

  it('does not touch the request it was given', () => {
    const body = { instructions: 'x', input: [] };
    droidBody('responses', body);
    expect(body.instructions).toBe('x');
  });

  it('rewords pi\'s opening sentence and compaction summary', () => {
    const body = {
      instructions: 'You are an expert coding assistant operating inside pi, a coding agent harness. Rest.',
      input: [{ role: 'user', content: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nS\n</summary>' }],
    };
    const out = droidBody('responses', body);
    expect(out.instructions).toBe(DROID_LINE + '\nYou are an expert coding assistant. Rest.');
    expect(out.input[0].content).toBe('Earlier conversation context is summarized below:\n\n<summary>\nS\n</summary>');
  });
});

describe('Anthropic requests', () => {
  it('puts droid\'s identity first, drops the billing block and replaces Claude Code\'s identity', () => {
    const body = { messages: [], system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1' }, { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.\nplus" }, { type: 'text', text: '   ' }] };
    expect(anthropicBody(body).system).toEqual([{ type: 'text', text: DROID_LINE + '\nplus' }]);
    expect(anthropicBody({ messages: [], system: 'x' }).system).toEqual([{ type: 'text', text: DROID_LINE }, { type: 'text', text: 'x' }]);
  });

  it('returns a request that needs nothing as the same object', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }], system: [{ type: 'text', text: DROID_LINE }] };
    expect(anthropicBody(body)).toBe(body);
    const odd = { messages: [], system: { x: 1 } };
    expect(anthropicBody(odd)).toBe(odd);
    const notMessages = { prompt: 'x' };
    expect(anthropicBody(notMessages)).toBe(notMessages);
  });

  it('rewords reminders, keeps quoted tool output recoverable and drops context_management from a stream', () => {
    const model = '<system-reminder>\nYou are powered by the model named Opus 5. The exact model ID is claude-opus-5.\n</system-reminder>';
    const body = {
      stream: true,
      context_management: { edits: [] },
      system: DROID_LINE,
      messages: [{ role: 'user', content: [{ type: 'text', text: model }, { type: 'tool_result', tool_use_id: 't', content: "You are Claude Code, Anthropic's official CLI for Claude." }] }],
    };
    const out = anthropicBody(body);
    expect('context_management' in out).toBe(false);
    expect('context_management' in body).toBe(true);
    expect(out.messages[0].content[0].text).toMatch(/Current model name: Opus 5\. Model ID: claude-opus-5\./);
    const quoted = out.messages[0].content[1].content;
    expect(quoted.startsWith('Tool output encoded as a JSON string.')).toBe(true);
    expect(quoted.includes('You are Claude')).toBe(false);
    expect(JSON.parse(quoted.split('\n').slice(1).join('\n').replaceAll('\\u0059', 'Y'))).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  it('rewrites texts and reports whether anything changed', () => {
    const m = { content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] };
    expect(rewriteContent(m, 'content', (t) => t.toUpperCase())).toBe(true);
    expect(m.content).toEqual([{ type: 'text', text: 'A' }, { type: 'image' }, { type: 'text', text: 'B' }]);
    expect(rewriteContent(m, 'content', (t) => t)).toBe(false);
    const h = { v: 'x' };
    expect(rewrite(h, 'v', (t) => t)).toBe(false);
    expect(rewrite(h, 'v', (t) => t + 'y')).toBe(true);
  });

  it('words the generated metadata the way Factory takes it', () => {
    expect(modelWording('You are powered by the model named X. Assistant knowledge cutoff is Y.')).toBe('Current model name: X. Model knowledge cutoff: Y.');
    const line = '- update-config: Use this skill to configure the Claude Code harness via settings.json. Automated behaviors ("from now on when X", "each time X", "whenever X", "before/after X") require hooks configured in settings.json - the harness executes these, not Claude, so memory/preferences cannot fulfill them.';
    expect(configSkillCompat(line + '\n- b: c')).toContain('not the assistant, so');
    expect(quotedToolText('plain text')).toBe('plain text');
  });
});

describe('provider.prepare', () => {
  it('sends droid\'s headers, the route\'s vendor and the account\'s org', async () => {
    const q = queue();
    const out = await prepare(req('responses', { model: 'gpt-6-sol', input: [] }), account(), q.opts);
    expect(out.url).toBe('https://api.factory.ai/api/llm/o/v1/responses');
    const h = out.headers;
    expect(h.authorization).toBe('Bearer ' + JSON.parse(globalThis.__astraTestHost.accounts.get('factory').get('a@b.c').secret).access);
    expect(h['x-factory-org-id']).toBe('org_1');
    expect(h['x-api-provider']).toBe('openai');
    expect(h['x-session-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(h['user-agent']).toBe('factory-cli/0.233.0');
    expect(h['openai-platform']).toBe('org-bHuLtG1fGmYk5YaOihAAXFBw');
    expect(h['x-api-key']).toBeUndefined();
    expect(out.body.instructions).toBe(DROID_LINE);
    expect(q.calls.length).toBe(0);
  });

  it('keeps one session id across requests of the engine, and a message id for each', async () => {
    const q = queue();
    const a = await prepare(req('chat', { model: 'glm-5.3', messages: [] }), account(), q.opts);
    expect(a.url).toBe('https://api.factory.ai/api/llm/o/v1/chat/completions');
    expect(a.headers['x-api-provider']).toBe('fireworks');
    expect(a.body.messages[0]).toEqual({ role: 'system', content: DROID_LINE });
  });

  it('sends an Anthropic request with the placeholder key and the adapted system', async () => {
    const out = await prepare(req('anthropic', { model: 'claude-opus-5', system: 's', messages: [] }), account(), { permissions: PERMS });
    expect(out.url).toBe('https://api.factory.ai/api/llm/a/v1/messages');
    expect(out.headers['x-api-key']).toBe('placeholder');
    expect(out.headers['x-api-provider']).toBe('anthropic');
    expect(out.body.system[0].text).toBe(DROID_LINE);
    const counting = await prepare(req('anthropic', { model: 'claude-opus-5', messages: [] }, { path: '/v1/messages/count_tokens' }), account(), { permissions: PERMS });
    expect(counting.url).toBe('https://api.factory.ai/api/llm/a/v1/messages/count_tokens');
  });

  it('takes the vendor from the route for a model it does not know', async () => {
    expect((await prepare(req('chat', { model: 'new-one', messages: [] }), account(), { permissions: PERMS })).headers['x-api-provider']).toBe('openai');
    expect((await prepare(req('anthropic', { model: 'new-one', messages: [] }), account(), { permissions: PERMS })).headers['x-api-provider']).toBe('anthropic');
  });

  it('serves an EU org from Factory\'s EU region and refuses one with a host of its own', async () => {
    expect((await prepare(req('responses', { input: [] }), account({ region: 'eu' }), { permissions: PERMS })).url).toBe('https://api.eu.factory.ai/api/llm/o/v1/responses');
    await expect(prepare(req('responses', { input: [] }), account({ premBaseHost: 'prem.example.com' }), { permissions: PERMS })).rejects.toThrow(/own host/);
  });

  it('refuses a protocol Factory does not speak and a request with no account', async () => {
    await expect(prepare(req('gemini'), account(), { permissions: PERMS })).rejects.toThrow(/gemini/);
    await expect(runProvider(plugin, 'factory', 'prepare', req('chat'), null, { permissions: PERMS })).rejects.toThrow(/no account/);
  });

  it('sends an API key as the bearer, with no org', async () => {
    const key = { type: 'key', access: 'fk-1', refresh: '', expires: 0, region: 'eu', activeOrganizationId: '' };
    const out = await prepare(req('chat', { model: 'glm-5.3', messages: [] }), key, { permissions: PERMS });
    expect(out.headers.authorization).toBe('Bearer fk-1');
    expect(out.headers['x-factory-org-id']).toBeUndefined();
    expect(out.url.startsWith('https://api.eu.factory.ai/')).toBe(true);
  });

  it('renews a token near its end once, saves the new pair, and spends the refresh token once', async () => {
    const next = jwt({ exp: secs(7200) });
    const q = queue(json({ access_token: next, refresh_token: 'r2' }));
    const out = await prepare(req('chat', { model: 'glm-5.3', messages: [] }), nearEnd(), q.opts);
    expect(out.headers.authorization).toBe('Bearer ' + next);
    expect(q.calls.length).toBe(1);
    expect(q.calls[0].url).toBe('https://api.workos.com/user_management/authenticate');
    expect(form(q.calls[0].body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1' });
    expect(heldSecret()).toMatchObject({ access: next, refresh: 'r2', type: 'oauth' });
  });

  it('lapses the account when WorkOS refuses the refresh token for good', async () => {
    const q = queue(json({ error: 'invalid_grant', error_description: 'gone' }, 400));
    await expect(prepare(req('chat'), nearEnd(), q.opts)).rejects.toThrow(/sign in again/);
    expect(globalThis.__astraTestHost.accounts.get('factory').get('a@b.c').status).toBe('expired');
  });

  it('goes on with a live token through a rate limit, and fails when the token is dead too', async () => {
    const live = queue(json({}, 429));
    const out = await prepare(req('chat', { messages: [] }), nearEnd(), live.opts);
    expect(out.headers.authorization).toMatch(/^Bearer /);
    const dead = queue(json({}, 429));
    await expect(prepare(req('chat'), account({ access: jwt({ exp: secs(-30) }), expires: Date.now() - 30e3 }), dead.opts)).rejects.toThrow(/429|Too Many/);
  });

  it('reads a damaged secret as a sign-in to redo', async () => {
    await expect(runProvider(plugin, 'factory', 'prepare', req('chat'), { key: 'a@b.c', secret: 'nope' }, { permissions: PERMS })).rejects.toThrow(/sign in again/);
  });
});

describe('provider.refresh', () => {
  const run = (c, q) => runProvider(plugin, 'factory', 'refresh', null, stored(c), q.opts);

  it('drops an org Factory refused and asks whoami again', async () => {
    // a renewal first (the token was not just renewed), then whoami with the old org (403), then without it
    const next = jwt({ exp: secs(7200) });
    const refusal = { status: 403, body: JSON.stringify({ error: 'Requested active organization is not accessible by this user' }) };
    const q = queue(json({ access_token: next, refresh_token: 'r2' }), refusal, json({ orgId: 'org_new', region: 'eu' }));
    expect(await run(account(), q)).toBe('renewed');
    expect(heldSecret()).toMatchObject({ activeOrganizationId: 'org_new', region: 'eu', refresh: 'r2' });
    expect(q.calls[1].headers['x-factory-org-id']).toBe('org_1');
    expect(q.calls[2].headers['x-factory-org-id']).toBeUndefined();
  });

  it('puts a token that names no org in the first one the account belongs to', async () => {
    const q = queue(json({ access_token: jwt({ exp: secs(7200) }), refresh_token: 'r2' }), json({}, 404), json({ workosOrgIds: ['wo_9'] }), json({ access_token: jwt({ exp: secs(7200) }), refresh_token: 'r3' }));
    expect(await run(account({ activeOrganizationId: '', orgId: '' }), q)).toBe('renewed');
    expect(form(q.calls[3].body).organization_id).toBe('wo_9');
    expect(heldSecret()).toMatchObject({ orgId: 'wo_9', refresh: 'r3' });
  });

  it('answers expired when WorkOS refuses the refresh token for good', async () => {
    const q = queue(json({ error: 'invalid_grant' }, 400));
    expect(await run(account(), q)).toBe('expired');
    expect(globalThis.__astraTestHost.accounts.get('factory').get('a@b.c').status).toBe('expired');
  });

  it('asks a key\'s whoami once and keeps where its org is served', async () => {
    const key = { type: 'key', access: 'fk-1', refresh: '', expires: 0, region: '', activeOrganizationId: '' };
    const q = queue(json({ orgId: 'o', region: 'eu', email: 'k@x.y' }));
    expect(await runProvider(plugin, 'factory', 'refresh', null, { key: 'a@b.c', secret: JSON.stringify(key) }, q.opts)).toBe('renewed');
    expect(heldSecret()).toMatchObject({ region: 'eu', email: 'k@x.y', whoKnown: true });
    expect(q.calls[0].headers.authorization).toBe('Bearer fk-1');
  });
});

describe('provider.usage', () => {
  const run = (c, q) => runProvider(plugin, 'factory', 'usage', null, stored(c), q.opts);

  it('reads the plan\'s windows', async () => {
    const q = queue(json({ limits: { standard: { weekly: { usedPercent: 25 } } } }));
    const u = await run(account(), q);
    expect(u.windows).toEqual([{ name: '7 days', used: 25, span: 604800, notModels: CORE }]);
    expect(u.used).toBe(0.25);
    expect(u.label).toBe('25%');
    expect(q.calls[0].url).toBe('https://api.factory.ai/api/billing/limits');
  });

  it('says so when the plan reports no limits, and when Factory refuses', async () => {
    expect((await run(account(), queue(json({})))).error).toMatch(/no limits/);
    expect((await run(account(), queue({ status: 500, body: '{}' }))).error).toMatch(/500/);
  });

  it('asks once more after an org refusal was put right', async () => {
    const refusal = { status: 403, body: JSON.stringify({ error: 'Requested active organization is not accessible by this user' }) };
    const q = queue(refusal, json({ access_token: jwt({ exp: secs(7200) }), refresh_token: 'r2' }), json({ orgId: 'org_2' }), json({ limits: { standard: { weekly: { usedPercent: 1 } } } }));
    expect((await run(account(), q)).windows.length).toBe(1);
  });
});

describe('sign-in flow', () => {
  const ui = { permissions: PERMS };
  const dc = { device_code: 'dc', user_code: 'ABCD', verification_uri: 'https://v', verification_uri_complete: 'https://v?c=ABCD', interval: 1 };

  it('keeps an API key and what whoami says about it', async () => {
    const q = queue(json({ orgId: 'o', region: 'eu', email: 'k@x.y', userId: 'u1' }));
    const view = await mount(signIn, { ...q.opts });
    await view.press('key');
    await view.change('key', ' fk-abc ');
    const effects = await view.press('saveKey');
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const held = globalThis.__astraTestHost.accounts.get('factory').get('k@x.y');
    expect(JSON.parse(held.secret)).toMatchObject({ type: 'key', access: 'fk-abc', region: 'eu', whoKnown: true });
    expect(q.calls[0].headers.authorization).toBe('Bearer fk-abc');
  });

  it('asks for the key when it is left empty', async () => {
    const view = await mount(signIn, ui);
    await view.press('key');
    const effects = await view.press('saveKey');
    expect(effects.some((e) => e.type === 'close')).toBe(false);
  });

  it('polls until the code is confirmed, then keeps the org and region whoami names', async () => {
    const q = queue(
      json(dc),
      json({ error: 'authorization_pending' }, 400),
      json({ access_token: jwt({ exp: secs(3600), org_id: 'wo_1', email: 'e@x.y' }), refresh_token: 'rt' }),
      json({ orgId: 'org_f', region: 'eu', userId: 'u1' }),
    );
    const view = await mount(signIn, q.opts);
    const effects = await view.press('device');
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const held = JSON.parse(globalThis.__astraTestHost.accounts.get('factory').get('e@x.y').secret);
    expect(held).toMatchObject({ type: 'oauth', email: 'e@x.y', activeOrganizationId: 'org_f', region: 'eu', refresh: 'rt', orgId: 'wo_1' });
    expect(form(q.calls[0].body).client_id).toBe('client_01HNM792M5G5G1A2THWPXKFMXB');
    expect(form(q.calls[1].body)).toMatchObject({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'dc' });
  }, 15000);

  it('shows an error and no account when the code is declined', async () => {
    const q = queue(json(dc), json({ error: 'access_denied' }, 400));
    const view = await mount(signIn, q.opts);
    const effects = await view.press('device');
    expect(effects.some((e) => e.type === 'close')).toBe(false);
    expect(view.state.error).toMatch(/declined|signIn\.denied/);
    expect(globalThis.__astraTestHost.accounts.get('factory')?.size ?? 0).toBe(0);
  }, 15000);
});

describe('upgrade from the v1 plugin', () => {
  it('turns the v1 sign-ins into accounts, once', async () => {
    await runProvider(plugin, 'factory', 'models', null, null, { permissions: PERMS });
    const h = globalThis.__astraTestHost;
    h.accounts.clear();
    const auth = {
      factory: { type: 'oauth', access: 'tok', refresh: 'r', expires: 1, accountId: 'old@x.y', activeOrganizationId: 'o1', region: 'eu' },
      'factory#2': { type: 'api', key: 'fk-9', metadata: { email: 'key@x.y', region: 'eu' } },
      'factory#3': { type: 'wellknown' },
    };
    await h.run({ op: 'activate', reason: 'upgrade', upgrade: { from: { apiVersion: 1, package: '@astragate-community/factory-auth', spec: 's', auth } } });
    const rows = h.accounts.get('factory');
    expect([...rows.keys()].sort()).toEqual(['key@x.y', 'old@x.y']);
    expect(JSON.parse(rows.get('old@x.y').secret)).toMatchObject({ type: 'oauth', access: 'tok', refresh: 'r', activeOrganizationId: 'o1', region: 'eu' });
    expect(JSON.parse(rows.get('key@x.y').secret)).toMatchObject({ type: 'key', access: 'fk-9', whoKnown: true });
    // a second activation with accounts present leaves them alone
    await h.run({ op: 'activate', reason: 'upgrade', upgrade: { from: { auth: { factory: { type: 'api', key: 'fk-other' } } } } });
    expect(rows.size).toBe(2);
  });
});

// ---- the 403 mended from the refused reply, and worded
describe('provider.refresh after a 403', () => {
  const orgBody = JSON.stringify({ error: { message: 'Requested active organization is not accessible by this user' } });
  const run = (c, q, failed) => runProvider(plugin, 'factory', 'refresh', failed, stored(c), q.opts);

  it('an org Factory refused is dropped and whoami asked again (no token renewal first)', async () => {
    const q = queue(json({ orgId: 'org_new', region: 'eu' }));
    expect(await run(account(), q, { status: 403, body: orgBody })).toBe('renewed');
    expect(q.calls).toHaveLength(1);
    expect(heldSecret()).toMatchObject({ activeOrganizationId: 'org_new', region: 'eu' });
  });

  it('whoami naming the refused org itself means sending none', async () => {
    const q = queue(json({ orgId: 'org_1' }));
    expect(await run(account(), q, { status: 403, body: orgBody })).toBe('renewed');
    expect(heldSecret().activeOrganizationId).toBe('');
  });

  it('another 403, with an org sent, is left alone', async () => {
    const q = queue();
    expect(await run(account(), q, { status: 403, body: '{"error":"model not allowed"}' })).toBeNull();
    expect(q.calls).toHaveLength(0);
  });

  it('a 403 to an account that sent no org asks whoami for one', async () => {
    const q = queue(json({ orgId: 'org_7' }));
    expect(await run(account({ activeOrganizationId: '', orgId: '' }), q, { status: 403, body: '{"error":"nope"}' })).toBe('renewed');
    expect(heldSecret().activeOrganizationId).toBe('org_7');
  });
});

// ---- the reply: wrapped tools unwrapped, 403 worded, everything else passed on as it came
const anyOfSchema = { anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }] };
const anthropicReq = (extra = {}) => req('anthropic', { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'pick', description: 'd', input_schema: anyOfSchema }, { name: 'plain', input_schema: { type: 'object', properties: {} } }], ...extra }, { model: 'claude-sonnet-5' });
const prep = (r) => prepare(r, account(), { permissions: PERMS });
const reply = (input) => runResponse(plugin, 'factory', { framing: 'ndjson', ...input });
const text = (...ls) => ls.map((t) => ({ text: t }));
const sseLines = (events) => events.flatMap((e) => [`event: ${e.type}`, 'data: ' + JSON.stringify(e)]);
const toolStream = (jsonParts, name = 'pick') => [
  { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [] } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name, input: {} } },
  ...jsonParts.map((partial_json) => ({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } })),
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
];

describe('wrapped tools', () => {
  beforeEach(forget);

  it('wraps a root anyOf schema under one argument, in the tools and the history', async () => {
    const out = await prep(anthropicReq({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'pick', input: { a: 'z' } }] }] }));
    const tool = out.body.tools.find((t) => t.name === 'pick');
    expect(tool.input_schema).toEqual({ type: 'object', properties: { arguments: anyOfSchema }, required: ['arguments'], additionalProperties: false });
    expect(out.body.tools.find((t) => t.name === 'plain').input_schema.properties).toEqual({});
    expect(out.body.messages[1].content[0].input).toEqual({ arguments: { a: 'z' } });
  });

  it('rebases $ref pointers into the wrapper and leaves data alone', () => {
    const { body, names } = wrapAnthropicTools({ messages: [], tools: [{ name: 't', input_schema: { oneOf: [{ $ref: '#/$defs/x' }], $defs: { x: { type: 'string', default: { $ref: '#/data' } } } } }] });
    expect(names.has('t')).toBe(true);
    expect(body.tools[0].input_schema.properties.arguments.oneOf[0].$ref).toBe('#/properties/arguments/$defs/x');
    expect(body.tools[0].input_schema.properties.arguments.$defs.x.default).toEqual({ $ref: '#/data' });
  });

  it('leaves a request with nothing to wrap as it is', () => {
    const b = { messages: [], tools: [{ name: 'p', input_schema: { type: 'object' } }] };
    expect(wrapAnthropicTools(b).body).toBe(b);
  });

  it('unwraps the arguments in a stream, holding the argument events back until the block ends', async () => {
    await prep(anthropicReq());
    const out = await reply({ request: { protocol: 'anthropic', model: 'claude-sonnet-5', stream: true }, frames: text(...sseLines(toolStream(['{"argu', 'ments":{"a":"x"}}']))) });
    expect(out.failure).toBeNull();
    const types = out.frames.map((f) => f.event);
    expect(types).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(out.frames[4].data.content_block.input).toEqual({});
    expect(JSON.parse(out.frames[5].data.delta.partial_json)).toEqual({ a: 'x' });
  });

  it('unwraps a JSON message (one line or pretty-printed), only for wrapped names', async () => {
    await prep(anthropicReq());
    const message = { id: 'm', type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'pick', input: { arguments: { b: 2 } } }, { type: 'tool_use', id: 'u', name: 'plain', input: { arguments: 1 } }] };
    const request = { protocol: 'anthropic', model: 'claude-sonnet-5', stream: false };
    const one = await reply({ request, frames: [{ json: message }] });
    expect(one.body.content[0].input).toEqual({ b: 2 });
    expect(one.body.content[1].input).toEqual({ arguments: 1 });
    const pretty = await reply({ request, frames: text(...JSON.stringify(message, null, 2).split('\n')) });
    expect(pretty.body).toEqual(one.body);
    expect(unwrapMessage(message, new Set())).toBe(message);
  });

  it('fails a stream whose wrapped block does not carry the wrapper, or never ends', async () => {
    await prep(anthropicReq());
    const request = { protocol: 'anthropic', model: 'claude-sonnet-5', stream: true };
    const bad = await reply({ request, frames: text(...sseLines(toolStream(['{"x":1}']))) });
    expect(bad.failure).toMatchObject({ status: 502, message: expect.stringContaining('invalid arguments') });
    const cut = await reply({ request, frames: text(...sseLines(toolStream(['{"arguments":1}']).slice(0, 6))) });
    expect(cut.failure).toMatchObject({ status: 502, message: expect.stringContaining('incomplete') });
  });

  it('passes a reply with no wrapped tools on untouched, in all three protocols', async () => {
    forget();
    const a = await reply({ request: { protocol: 'anthropic', model: 'claude-sonnet-5', stream: true }, frames: text(...sseLines(toolStream(['{"arguments":1}']))) });
    expect(a.frames[5].data.delta.partial_json).toBe('{"arguments":1}');
    const chunk = { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] };
    const c = await reply({ request: { protocol: 'chat', model: 'glm', stream: true }, frames: text('data: ' + JSON.stringify(chunk), '', 'data: [DONE]') });
    expect(c.frames).toEqual([chunk, '[DONE]']);
    const r = { type: 'response.output_text.delta', delta: 'x' };
    const o = await reply({ request: { protocol: 'responses', model: 'gpt', stream: true }, frames: text('event: response.output_text.delta', 'data: ' + JSON.stringify(r)) });
    expect(o.frames).toEqual([{ event: 'response.output_text.delta', data: r }]);
    const body = { id: 'chatcmpl', object: 'chat.completion', choices: [] };
    expect((await reply({ request: { protocol: 'chat', model: 'glm', stream: false }, frames: [{ json: body }] })).body).toEqual(body);
  });
});

describe('a refused request', () => {
  const refuse = (status, body) => reply({ request: { protocol: 'anthropic', model: 'claude-sonnet-5', stream: true }, response: { status, body } });

  it('words a 403 with the vendor message and what to do', async () => {
    const out = await refuse(403, '{"error":{"message":"Requested active organization is not accessible by this user"}}');
    expect(out.error.status).toBe(403);
    expect(out.error.message).toContain('Requested active organization is not accessible by this user — the Factory account\'s organization changed');
    const other = await refuse(403, '{"detail":"plan does not include this model"}');
    expect(other.error.message).toMatch(/^plan does not include this model — Factory refused the request/);
    expect((await refuse(403, '<html>')).error.message).toMatch(/^403 Forbidden — /);
  });

  it('passes other refusals on as they are', async () => {
    for (const status of [401, 429, 500]) {
      const out = await refuse(status, '{"error":"x"}');
      expect(out.error).toBeNull();
      expect(out.status).toBe(status);
    }
  });
});
