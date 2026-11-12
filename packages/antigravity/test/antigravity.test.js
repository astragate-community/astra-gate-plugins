import { beforeEach, describe as suite, expect, it } from 'vitest';
import { mount, runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin, { signIn } from '../src/main.js';
import { forgetVersion, userAgent } from '../src/client.js';
import { CodeAssistError, describe, durationMs, gone } from '../src/errors.js';
import { plainSchema } from '../src/schema.js';
import { history } from '../src/history.js';
import { generation, geminiGeneration, levelOf } from '../src/generation.js';
import { cloak, envelope, sessionOf, shape } from '../src/request.js';
import { MODELS, familyOf, forgetLists, hostModel, levelOfId, listModels, parseModels, resolveModel, thinks } from '../src/models.js';
import { fresh } from '../src/session.js';
import { merge, refusalOf, unwrap } from '../src/reply.js';
import { authorizeURL, base64url, challengeOf, readCode } from '../src/signin.js';
import { balanceOf, planName, usageOf } from '../src/usage.js';
import { defaultTier, projectOf } from '../src/api.js';
import { DAILY, SKIP_SIGNATURE } from '../src/constants.js';

const PERMS = [
  'providers', 'storage', 'ui',
  'net:https://daily-cloudcode-pa.googleapis.com', 'net:https://cloudcode-pa.googleapis.com', 'net:https://oauth2.googleapis.com',
  'net:https://www.googleapis.com', 'net:https://antigravity-hub-auto-updater-974169037036.us-central1.run.app',
];
const CONFIG = { clientId: 'test.apps.googleusercontent.com', clientSecret: 'not-a-secret' };
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });
const hours = (n) => Date.now() + n * 3600_000;
const secretOf = (extra = {}) => JSON.stringify({ access: 'AT', refresh: 'RT', expires: hours(1), project: 'proj-1', ...extra });
const geminiBody = (extra = {}) => ({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], ...extra });

// a faked network answering by url; the updater's page is answered whatever the test says
function net(route) {
  const calls = [];
  return {
    calls,
    opts: {
      permissions: PERMS,
      config: CONFIG,
      fetch: async (req) => {
        if (req.url.includes('antigravity-hub-auto-updater')) return { status: 200, body: 'version: 2.24.0\nfiles:\n' };
        calls.push(req);
        return route(req);
      },
    },
  };
}
const request = (model, action, body, extra = {}) => ({ protocol: 'gemini', model, path: `/v1beta/models/${model}:${action}`, method: 'POST', headers: {}, body, stream: action === 'streamGenerateContent', ...extra });
const account = { key: 'me@example.com' };
const prepare = (req, secret, route = () => json({})) => {
  const n = net(route);
  return runProvider(plugin, 'antigravity', 'prepare', req, { ...account, secret }, n.opts).then((out) => ({ out, calls: n.calls }));
};

beforeEach(() => {
  forgetVersion();
  forgetLists();
});

suite('reading what Code Assist refuses with', () => {
  it('durations as Google says them', () => {
    expect(durationMs('0.5s')).toBe(500);
    expect(durationMs('4m50s')).toBe(290000);
    expect(durationMs('200ms')).toBe(200);
    expect(durationMs('soon')).toBe(0);
  });

  it('a rate limit with its delay, a host\'s busy words, a model out of room', () => {
    const limit = describe(429, JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'You have exhausted your capacity on this model. Your quota will reset after 3s.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', metadata: { model: 'gemini-3-flash' } }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3.5s' }] } }));
    expect(limit).toMatchObject({ kind: 'limit', waitMs: 3500, model: 'gemini-3-flash' });
    expect(describe(429, JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' } })).kind).toBe('busy');
    const cap = describe(503, JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'No capacity available', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'MODEL_CAPACITY_EXHAUSTED' }] } }));
    expect(cap.kind).toBe('capacity');
  });

  it('a 403 that wants the account verified, one that says it broke the terms', () => {
    const v = describe(403, JSON.stringify({ error: { message: 'Verify your account to continue.', details: [{ metadata: { validation_url: 'https://accounts.google.com/verify' } }] } }));
    expect(v.kind).toBe('validation');
    expect(v.message).toMatch(/https:\/\/accounts\.google\.com\/verify/);
    expect(describe(403, JSON.stringify({ error: { message: 'This account has violated the Terms of Service' } })).kind).toBe('violation');
    expect(describe(403, JSON.stringify({ error: { message: 'nope' } })).kind).toBe('forbidden');
    expect(describe(401, '').kind).toBe('auth');
    expect(describe(502, '<html>bad gateway</html>').message).toBe('<html>bad gateway</html>');
  });

  it('a CodeAssistError says the method and the status', () => {
    const e = new CodeAssistError(400, JSON.stringify({ error: { message: 'bad project' } }), 'loadCodeAssist');
    expect(e.message).toBe('Antigravity loadCodeAssist: bad project (400)');
    expect(e.status).toBe(400);
    expect(gone('x').gone).toBe(true);
  });
});

suite('schemas', () => {
  it('a schema is cut down to the subset Antigravity takes', () => {
    const out = plainSchema({
      $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
      $defs: { Mode: { type: 'string', enum: ['a', 'b'], default: 'a' } },
      properties: {
        mode: { $ref: '#/$defs/Mode' },
        n: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'count' },
        list: { type: 'array', items: { type: ['string', 'null'], format: 'uri' } },
        tag: { const: 'x' },
        lo: { type: 'number', exclusiveMinimum: 0 },
      },
      required: ['mode', 'ghost'],
    });
    expect(out).toEqual({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['a', 'b'] },
        n: { type: 'integer', nullable: true, description: 'count' },
        list: { type: 'array', items: { type: 'string', nullable: true } },
        tag: { enum: ['x'] },
        lo: { type: 'number', minimum: 0 },
      },
      required: ['mode'],
    });
  });

  it('allOf is one schema; a missing or empty schema is an object with no properties', () => {
    expect(plainSchema({ allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'number' } } }] }))
      .toEqual({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] });
    expect(plainSchema(undefined)).toEqual({ type: 'object', properties: {} });
    expect(plainSchema({})).toEqual({ type: 'object', properties: {} });
  });
});

const call = (name, extra = {}) => ({ functionCall: { name, args: {} }, ...extra });
const answer = (name, extra = {}) => ({ functionResponse: { name, response: { result: 'ok' }, ...extra } });

suite('conversations', () => {
  it('a Claude model\'s calls get ids, and the answers after them take the same', () => {
    const out = history([
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts: [call('a'), call('b'), call('a')] },
      { role: 'user', parts: [answer('b'), answer('a'), answer('a')] },
    ], { claude: true });
    expect(out[1].parts.map((p) => p.functionCall.id)).toEqual(['call_1', 'call_2', 'call_3']);
    expect(out[2].parts.map((p) => p.functionResponse.id)).toEqual(['call_2', 'call_1', 'call_3']);
    expect(out[1].parts.every((p) => p.thoughtSignature === SKIP_SIGNATURE)).toBe(true);
  });

  it('a Gemini call the model signed keeps its signature; one it didn\'t is told to skip the check', () => {
    const out = history([
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts: [call('a', { thoughtSignature: 'SIG' }), call('b')] },
      { role: 'user', parts: [answer('a'), answer('b')] },
      { role: 'model', parts: [call('c')] },
      { role: 'user', parts: [answer('c')] },
    ]);
    expect(out[1].parts[0].thoughtSignature).toBe('SIG');
    expect(out[1].parts[1].thoughtSignature).toBeUndefined();
    expect(out[3].parts[0].thoughtSignature).toBe(SKIP_SIGNATURE);
    expect(out[1].parts[0].functionCall.id).toBeUndefined();
  });

  it('a call nobody answered is answered with a note; a history may not open or end with the model\'s turn', () => {
    const out = history([
      { role: 'model', parts: [{ text: 'earlier' }] },
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts: [call('a')] },
      { role: 'user', parts: [{ text: 'never mind' }] },
      { role: 'model', parts: [{ text: 'ok' }] },
    ]);
    expect(out[0].role).toBe('user');
    expect(out[0].parts[0].text).toMatch(/Continuing/);
    const i = out.findIndex((c) => c.parts.some((p) => p.functionResponse));
    expect(out[i].parts[0].functionResponse.response.result).toMatch(/interrupted/);
    expect(out[i + 1].parts[0].text).toBe('never mind');
    expect(out.at(-1).role).toBe('user');
  });

  it('a Claude model keeps the answers and what the user said in one turn', () => {
    const turns = [
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts: [call('a')] },
      { role: 'user', parts: [answer('a'), { text: 'and also' }] },
    ];
    const claude = history(structuredClone(turns), { claude: true });
    expect(claude).toHaveLength(3);
    expect(claude[2].parts).toHaveLength(2);
    expect(history(structuredClone(turns))).toHaveLength(4);
  });

  it('a tool\'s answer is read from result: Gemini CLI\'s output and an error\'s words are moved there', () => {
    const out = history([
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts: [call('a'), call('b'), call('c')] },
      { role: 'user', parts: [{ functionResponse: { name: 'a', response: { output: 'fine' } } }, { functionResponse: { name: 'b', response: { error: 'boom' } } }, { functionResponse: { name: 'c', response: { result: 'kept', extra: 1 } } }] },
    ]);
    expect(out[2].parts.map((p) => p.functionResponse.response)).toEqual([{ result: 'fine' }, { result: 'boom' }, { result: 'kept', extra: 1 }]);
  });
});

suite('thinking', () => {
  it('Gemini 3 and later are told a level; Astra\'s budgets are the sizes of low, medium, high', () => {
    expect(geminiGeneration('gemini-3.8-flash-high')).toBe(3);
    expect(geminiGeneration('gemini-2.5-flash')).toBe(2);
    expect(levelOf({ thinkingBudget: 0 })).toBe('low');
    expect(levelOf({ thinkingBudget: 1024 })).toBe('low');
    expect(levelOf({ thinkingBudget: 4096 })).toBe('medium');
    expect(levelOf({ thinkingBudget: 16384 })).toBe('high');
    expect(levelOf({ thinkingLevel: 'MEDIUM' })).toBe('medium');
    expect(generation({ thinkingConfig: { thinkingBudget: 4096, includeThoughts: true } }, 'gemini-3-flash').thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'medium' });
    expect(generation({ thinkingConfig: { thinkingBudget: 4096 } }, 'gemini-3-pro-high').thinkingConfig.thinkingLevel).toBe('high');
    expect(generation({ thinkingConfig: { thinkingBudget: 16384 } }, 'gemini-3.7-flash-low').thinkingConfig.thinkingLevel).toBe('low');
    expect(generation({ temperature: 1 }, 'gemini-3-flash').thinkingConfig).toBeUndefined();
  });

  it('Gemini 2.5 keeps its budget (a Flash\'s is capped); Claude thinks only where the id says; GPT-OSS never', () => {
    expect(generation({ thinkingConfig: { thinkingBudget: 30000 } }, 'gemini-2.5-flash').thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 24576 });
    expect(generation({ thinkingConfig: { thinkingBudget: 4096 } }, 'claude-sonnet-4-6')?.thinkingConfig).toBeUndefined();
    const c = generation({ thinkingConfig: { thinkingBudget: 4096 }, maxOutputTokens: 2000 }, 'claude-opus-4-6-thinking');
    expect(c.thinkingConfig.thinkingBudget).toBe(1999);
    expect(generation({ thinkingConfig: { thinkingBudget: 4096 } }, 'claude-opus-4-6-thinking').maxOutputTokens).toBe(4096 + 32000);
    expect(generation({ thinkingConfig: { thinkingBudget: 4096 } }, 'gpt-oss-120b-medium')?.thinkingConfig).toBeUndefined();
    expect(generation({ maxOutputTokens: 200000 }, 'claude-sonnet-4-6').maxOutputTokens).toBe(64000);
    expect(generation({}, 'gemini-3.1-flash-image').responseModalities).toEqual(['TEXT', 'IMAGE']);
  });
});

suite('the request', () => {
  it('Claude Code\'s words in the system prompt are broken, in the system prompt only', () => {
    expect(cloak('x-anthropic-billing-header: cc')).toBe('x​-anthropic-billing-header: cc');
    expect(cloak('built on Anthropic\'s Claude Agent SDK.')).toBe('built on Anthropic\'s C​laude Agent SDK.');
    const out = shape(geminiBody({ systemInstruction: { parts: [{ text: 'x-anthropic-billing-header: a' }] }, contents: [{ role: 'user', parts: [{ text: 'x-anthropic-billing-header:' }] }] }), 'gemini-3-flash');
    expect(out.request.systemInstruction.parts[0].text).toBe('x​-anthropic-billing-header: a');
    expect(out.request.contents[0].parts[0].text).toBe('x-anthropic-billing-header:');
  });

  it('tools: schemas flattened, Gemini\'s own tools dropped when functions are declared, a Claude config validated', () => {
    const body = geminiBody({
      tools: [{ functionDeclarations: [{ name: 'ls', description: 'd', parametersJsonSchema: { type: 'object', properties: { p: { type: 'string', format: 'uri' } }, additionalProperties: false } }] }, { googleSearch: {} }],
    });
    const g = shape(body, 'gemini-3-flash');
    expect(g.request.tools).toEqual([{ functionDeclarations: [{ name: 'ls', description: 'd', parameters: { type: 'object', properties: { p: { type: 'string' } } } }] }]);
    expect(g.request.toolConfig).toBeUndefined();
    expect(shape(body, 'claude-sonnet-4-6').request.toolConfig.functionCallingConfig.mode).toBe('VALIDATED');
    expect(shape(geminiBody({ tools: [{ googleSearch: {} }] }), 'gemini-3-flash').request.tools[0].googleSearch).toBeDefined();
    expect(shape(geminiBody({ toolConfig: { functionCallingConfig: { mode: 'ANY' } }, tools: body.tools }), 'claude-sonnet-4-6').request.toolConfig.functionCallingConfig.mode).toBe('ANY');
  });

  it('a bare family goes out as the variant of the level asked for', () => {
    const known = new Set(['gemini-3.7-flash-low', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-high', 'gemini-3-flash']);
    expect(resolveModel('gemini-3.7-flash', known, 'medium')).toBe('gemini-3.7-flash-medium');
    expect(resolveModel('gemini-3.7-flash', known)).toBe('gemini-3.7-flash-high');
    expect(resolveModel('gemini-3-flash', known, 'low')).toBe('gemini-3-flash');
    expect(resolveModel('something-else', known)).toBe('something-else');
    expect(resolveModel('x', undefined)).toBe('x');
    const out = shape(geminiBody({ generationConfig: { thinkingConfig: { thinkingBudget: 4096 } } }), 'gemini-3.7-flash', { known });
    expect(out.model).toBe('gemini-3.7-flash-medium');
    expect(out.request.generationConfig.thinkingConfig.thinkingLevel).toBe('medium');
  });

  it('the envelope names the project and the app, and a conversation has one session', () => {
    const env = envelope(shape(geminiBody(), 'gemini-3-flash'), 'proj-1');
    expect(env).toMatchObject({ project: 'proj-1', userAgent: 'antigravity', requestType: 'agent', model: 'gemini-3-flash' });
    expect(env.requestId).toMatch(/^agent-[0-9a-f-]{36}$/);
    expect(env.request.sessionId).toBe(sessionOf([{ role: 'user', parts: [{ text: 'hi' }] }]));
    expect(env.request.sessionId).toMatch(/^-\d+$/);
    expect(sessionOf([{ role: 'user', parts: [{ text: 'other' }] }])).not.toBe(env.request.sessionId);
  });

  it('the User-Agent: version and platform', () => {
    expect(userAgent('2.24.0', 'darwin')).toBe('antigravity/hub/2.24.0 darwin/amd64');
    expect(userAgent('2.24.0', 'win32')).toBe('antigravity/hub/2.24.0 windows/amd64');
  });
});

suite('prepare', () => {
  it('goes to the daily host wrapped, with the account\'s token', async () => {
    const { out, calls } = await prepare(request('gemini-3-flash', 'streamGenerateContent', geminiBody()), secretOf());
    expect(out.url).toBe(`${DAILY}/v1internal:streamGenerateContent?alt=sse`);
    expect(out.headers.authorization).toBe('Bearer AT');
    expect(out.headers['user-agent']).toMatch(/^antigravity\/hub\/2\.24\.0 /);
    expect(out.body).toMatchObject({ project: 'proj-1', model: 'gemini-3-flash', userAgent: 'antigravity', requestType: 'agent' });
    expect(out.body.request.contents[0].parts[0].text).toBe('hi');
    expect(calls).toHaveLength(0); // a good token and a known project: nothing else asked
  });

  it('asks for the stream even when the client did not (Code Assist answers a stream only)', async () => {
    const { out } = await prepare(request('gemini-3-flash', 'generateContent', geminiBody()), secretOf());
    expect(out.url).toMatch(/streamGenerateContent\?alt=sse$/);
  });

  it('a token near its end is refreshed first, and kept in the account', async () => {
    const { out, calls } = await prepare(request('gemini-3-flash', 'streamGenerateContent', geminiBody()), secretOf({ expires: Date.now() + 60_000 }),
      (r) => (r.url.includes('/token') ? json({ access_token: 'AT2', expires_in: 3600 }) : json({})));
    expect(out.headers.authorization).toBe('Bearer AT2');
    expect(calls.map((c) => c.url)).toEqual(['https://oauth2.googleapis.com/token']);
    expect(calls[0].body).toContain('grant_type=refresh_token');
    expect(calls[0].body).toContain('refresh_token=RT');
    const kept = JSON.parse(globalThis.__astraTestHost.accounts.get('antigravity').get('me@example.com').secret);
    expect(kept).toMatchObject({ access: 'AT2', refresh: 'RT', project: 'proj-1' });
  });

  it('finds the project once and keeps it: asked of Code Assist, the account set up when it has none', async () => {
    const { out, calls } = await prepare(request('gemini-3-flash', 'streamGenerateContent', geminiBody()), secretOf({ project: '' }), (r) => {
      if (r.url.includes('loadCodeAssist')) return json({ currentTier: { id: 'free-tier', name: 'Antigravity' }, allowedTiers: [{ id: 'free-tier', isDefault: true }] });
      if (r.url.includes('onboardUser')) return json({ done: true, response: { cloudaicompanionProject: { id: 'new-proj' } } });
      return json({});
    });
    expect(out.body.project).toBe('new-proj');
    expect(calls.map((c) => c.url.match(/:(\w+)$/)[1])).toEqual(['loadCodeAssist', 'onboardUser']);
    expect(JSON.parse(calls[1].body).tier_id).toBe('free-tier');
    expect(JSON.parse(globalThis.__astraTestHost.accounts.get('antigravity').get('me@example.com').secret).project).toBe('new-proj');
  });

  it('turns a sign-in Google refused into a permission error, and a network failure into unavailable', async () => {
    const stale = secretOf({ expires: 1 });
    await expect(prepare(request('gemini-3-flash', 'streamGenerateContent', geminiBody()), stale, () => json({ error: 'invalid_grant', error_description: 'revoked' }, 400))).rejects.toThrow(/sign-in has expired/);
    await expect(prepare(request('gemini-3-flash', 'streamGenerateContent', geminiBody()), stale, () => json({ error: 'x' }, 503))).rejects.toThrow(/refused \(503\)/);
    await expect(prepare(request('gemini-3-flash', 'streamGenerateContent', geminiBody()), 'not json')).rejects.toThrow(/sign-in is gone/);
  });

  it('answers only Gemini\'s generateContent and streamGenerateContent', async () => {
    await expect(prepare(request('m', 'streamGenerateContent', geminiBody(), { protocol: 'chat' }), secretOf())).rejects.toThrow(/Gemini's protocol/);
    await expect(prepare(request('m', 'countTokens', geminiBody()), secretOf())).rejects.toThrow(/countTokens/);
    await expect(prepare(request('m', 'generateContent', null), secretOf())).rejects.toThrow(/isn't JSON/);
  });

  it('the version the updater names is asked once and kept in storage', async () => {
    const n = net(() => json({}));
    let asked = 0;
    const fetch = async (req) => (req.url.includes('auto-updater') ? (asked++, { status: 200, body: 'version: 9.9.9\n' }) : n.opts.fetch(req));
    const run = () => runProvider(plugin, 'antigravity', 'prepare', request('gemini-3-flash', 'streamGenerateContent', geminiBody()), { ...account, secret: secretOf() }, { ...n.opts, fetch, storage: globalThis.__astraTestHost?.storage ? Object.fromEntries([...globalThis.__astraTestHost.storage].map(([k, v]) => [k, JSON.parse(v)])) : {} });
    const first = await run();
    expect(first.headers['user-agent']).toContain('9.9.9');
    const second = await run();
    expect(second.headers['user-agent']).toContain('9.9.9');
    expect(asked).toBe(1);
  });
});

suite('refresh', () => {
  const refresh = (route, secret = secretOf()) => runProvider(plugin, 'antigravity', 'refresh', null, { ...account, secret }, net(route).opts);
  it('renews a token Google turned down', async () => {
    expect(await refresh((r) => (r.url.includes('/token') ? json({ access_token: 'AT2', expires_in: 3600 }) : json({})))).toBe('renewed');
    expect(JSON.parse(globalThis.__astraTestHost.accounts.get('antigravity').get('me@example.com').secret).access).toBe('AT2');
  });
  it('says expired when Google refuses the refresh token, and nothing when the network failed', async () => {
    expect(await refresh(() => json({ error: 'invalid_grant' }, 400))).toBe('expired');
    expect(await refresh(() => json({ error: 'x' }, 500))).toBeNull();
  });
});

suite('models and usage', () => {
  it('the built-in models without an account; the account\'s own list, in Antigravity\'s order, with one', async () => {
    expect((await runProvider(plugin, 'antigravity', 'models', null, null, net(() => json({})).opts)).map((m) => m.id)).toEqual(MODELS.map((m) => m.id));
    const n = net((r) => (r.url.includes('fetchAvailableModels') ? json({ models: { 'gemini-3-flash': { displayName: 'Gemini 3 Flash', maxTokens: 1048576, maxOutputTokens: 65535, supportsImages: true } } }) : json({})));
    const got = await runProvider(plugin, 'antigravity', 'models', null, { ...account, secret: secretOf() }, n.opts);
    expect(got).toEqual([{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', protocol: 'gemini', context: 1048576, output: 65535, vision: true, reasoning: true }]);
    const failing = net(() => json({ error: { message: 'no' } }, 500));
    forgetLists();
    const fallback = await runProvider(plugin, 'antigravity', 'models', null, { ...account, secret: secretOf({ project: 'other' }) }, failing.opts);
    expect(fallback.map((m) => m.id)).toEqual(MODELS.map((m) => m.id));
  });

  it('parses the account\'s list in the order of Antigravity\'s picker, without the models that aren\'t for chat', () => {
    const list = parseModels({
      models: {
        'gemini-3.1-flash-image': { displayName: 'Image' },
        'gemini-3-flash': { displayName: 'Gemini 3 Flash', maxTokens: 1048576, maxOutputTokens: 65535, supportsImages: true, quotaInfo: { remainingFraction: 0.5, resetTime: '2026-10-22T00:00:00Z' } },
        'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', quotaInfo: { resetTime: '2026-10-22T00:00:00Z' } },
        chat_20706: { displayName: 'internal' },
        tab_flash_lite_preview: { displayName: 'tab' },
      },
      agentModelSorts: [{ groups: [{ modelIds: ['claude-sonnet-4-6', 'gemini-3-flash'] }] }],
    });
    expect(list.map((m) => m.id)).toEqual(['claude-sonnet-4-6', 'gemini-3-flash', 'gemini-3.1-flash-image']);
    expect(list[0]).toMatchObject({ remaining: 0, reasoning: false });
    expect(list[1]).toMatchObject({ images: true, reasoning: true });
    expect(list[2].remaining).toBe(-1);
    expect(hostModel(list[1])).toMatchObject({ protocol: 'gemini', vision: true });
  });

  it('ids that are levels of one model', () => {
    expect(levelOfId('gemini-3.7-flash-low')).toBe('low');
    expect(levelOfId('gemini-3.5-flash-extra-low')).toBe('minimal');
    expect(levelOfId('gemini-3-flash')).toBe('');
    expect(familyOf('claude-opus-5-5-high')).toBe('claude-opus-5-5');
    expect(thinks('claude-opus-5-5-high')).toBe(true);
    expect(thinks('claude-sonnet-4-6')).toBe(false);
    expect(thinks('gemini-3.1-flash-image')).toBe(false);
  });

  it('an account\'s list is asked for once in a while, however often the host wants it', async () => {
    const n = net((r) => (r.url.includes('fetchAvailableModels') ? json({ models: { 'gemini-3-flash': { displayName: 'F' } } }) : json({})));
    const run = (secret) => runProvider(plugin, 'antigravity', 'models', null, { ...account, secret }, n.opts);
    await run(secretOf({ project: 'p-list' }));
    await run(secretOf({ project: 'p-list' }));
    expect(n.calls).toHaveLength(1);
    await run(secretOf({ project: 'other' }));
    expect(n.calls).toHaveLength(2);
    expect(listModels).toBeTypeOf('function');
  });

  it('the card is a window for each family of models, as full as the fullest of them is', () => {
    const models = parseModels({ models: {
      'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', quotaInfo: { remainingFraction: 0.5, resetTime: '2026-10-22T05:00:00Z' } },
      'claude-opus-4-6-thinking': { displayName: 'Claude Opus 4.6', quotaInfo: { remainingFraction: 0.25, resetTime: '2026-10-22T05:00:00Z' } },
      'gemini-3-flash': { displayName: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 1, resetTime: '2026-10-22T00:00:00Z' } },
      'gemini-3-pro-high': { displayName: 'Gemini 3 Pro', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-10-22T01:00:00Z' } },
    } });
    const load = { paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro', availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '1000' }] } };
    const card = usageOf(models, load, 'me@example.com');
    expect(card).toMatchObject({ plan: 'Google AI Pro', user: 'me@example.com', balance: '1,000 AI credits' });
    const by = Object.fromEntries(card.windows.map((w) => [w.name, w]));
    expect(by['Claude and GPT-OSS']).toMatchObject({ used: 75, display: '25% left' });
    expect([...by['Claude and GPT-OSS'].models].sort()).toEqual(['claude-opus-4-6-thinking', 'claude-sonnet-4-6']);
    expect(by['Gemini Flash'].used).toBe(0);
    expect(by['Gemini Pro'].resetsAt).toBe('2026-10-22T01:00:00Z');
    expect(planName({ paidTier: { id: 'g1-ultra-lite-tier' } })).toBe('Ultra');
    expect(planName({ currentTier: { id: 'free-tier' } })).toBe('Free');
    expect(planName(null)).toBe('');
    expect(balanceOf({ paidTier: { availableCredits: [{ creditType: 'X', creditAmount: '0' }] } })).toBe('');
  });

  it('usage reads the models and the plan', async () => {
    const n = net((r) => (r.url.includes('fetchAvailableModels') ? json({ models: { 'gemini-3-flash': { displayName: 'F', quotaInfo: { remainingFraction: 0.5, resetTime: '2026-10-22T00:00:00Z' } } } }) : json({ currentTier: { id: 'free-tier' } })));
    const u = await runProvider(plugin, 'antigravity', 'usage', null, { ...account, secret: secretOf() }, n.opts);
    expect(u.plan).toBe('Free');
    expect(u.windows[0].used).toBe(50);
  });
});

suite('the account', () => {
  it('a sign-in is fresh until it is near its end', () => {
    expect(fresh({ access: 'a', expires: hours(1) })).toBe(true);
    expect(fresh({ access: 'a', expires: Date.now() + 60_000 })).toBe(false);
    expect(fresh({ access: '', expires: hours(1) })).toBe(false);
  });

  it('the tier a new account is set up on, and the project as Code Assist words it', () => {
    expect(defaultTier({ allowedTiers: [{ id: 'legacy-tier', isDefault: true }] })).toBe('free-tier');
    expect(defaultTier({ allowedTiers: [{ id: 'g1-pro-tier' }, { id: 'x', isDefault: true }] })).toBe('x');
    expect(projectOf({ id: ' p ' })).toBe('p');
    expect(projectOf('q')).toBe('q');
  });
});

suite('signing in', () => {
  it('the sign-in page is Antigravity\'s client, offline, with PKCE', () => {
    const u = authorizeURL({ id: 'cid', secret: 's' }, 'http://localhost:51121/oauth-callback', 'S', 'V');
    expect(u.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    const q = Object.fromEntries(u.split('?')[1].split('&').map((p) => p.split('=').map(decodeURIComponent)));
    expect(q).toMatchObject({ client_id: 'cid', access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256', state: 'S', redirect_uri: 'http://localhost:51121/oauth-callback' });
    expect(q.scope).toMatch(/cclog/);
    expect(q.code_challenge).toBe(challengeOf('V'));
  });

  it('PKCE challenges are base64url of the SHA-256 (RFC 7636 appendix B)', () => {
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(base64url([251, 255, 254])).toBe('-__-');
    expect(base64url([1])).toBe('AQ');
  });

  it('a pasted address, query or code is read; another sign-in\'s, or Google\'s refusal, is not taken', () => {
    expect(readCode('4/0AbC-d', 'S')).toEqual({ code: '4/0AbC-d' });
    expect(readCode('http://localhost:51121/oauth-callback?state=S&code=4%2F0AbC&scope=x', 'S')).toEqual({ code: '4/0AbC' });
    expect(readCode('?code=c1&state=S', 'S')).toEqual({ code: 'c1' });
    expect(readCode('http://localhost:51121/oauth-callback?state=OTHER&code=c', 'S').error).toBe('signIn.error.otherSignIn');
    expect(readCode('http://localhost:51121/oauth-callback?error=access_denied&state=S', 'S')).toEqual({ error: 'signIn.error.google', detail: 'access_denied' });
    expect(readCode('http://localhost:51121/oauth-callback?state=S', 'S').error).toBe('signIn.error.noCode');
    expect(readCode('', 'S').error).toBe('signIn.error.empty');
  });

  const answers = (r) => {
    if (r.url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
    if (r.url.includes('userinfo')) return json({ email: 'me@example.com' });
    if (r.url.includes('loadCodeAssist')) return json({ cloudaicompanionProject: 'proj-9', currentTier: { id: 'free-tier', name: 'Free' } });
    return json({});
  };
  const open = async (route = answers) => {
    const n = net(route);
    const view = await mount(signIn, n.opts);
    const effects = await view.press('start');
    return { n, view, effects };
  };

  it('opens Google\'s page, trades the pasted code, names the account and finds its project', async () => {
    const { n, view, effects: opened } = await open();
    expect(opened.some((e) => e.type === 'openExternal')).toBe(true);
    expect(view.state.url).toMatch(/^https:\/\/accounts\.google\.com\//);
    const state = new URLSearchParams(view.state.url.split('?')[1]).get('state');
    expect(state).toBe(view.state.state);
    await view.change('address', `http://localhost:51121/oauth-callback?state=${state}&code=abc`);
    const effects = await view.press('finish');
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const form = n.calls.find((c) => c.url.includes('/token')).body;
    expect(form).toContain('code=abc');
    expect(form).toContain('grant_type=authorization_code');
    expect(form).toContain('code_verifier=' + encodeURIComponent(view.state.verifier));
    expect(form).toContain('redirect_uri=' + encodeURIComponent('http://localhost:51121/oauth-callback'));
    const kept = globalThis.__astraTestHost.accounts.get('antigravity').get('me@example.com');
    expect(JSON.parse(kept.secret)).toMatchObject({ refresh: 'RT', access: 'AT', project: 'proj-9' });
  });

  it('says what is wrong with a pasted address and keeps the sign-in open', async () => {
    const { view } = await open();
    await view.change('address', 'http://localhost:51121/oauth-callback?state=nope&code=c');
    const effects = await view.press('finish');
    expect(effects.some((e) => e.type === 'close')).toBe(false);
    expect(view.state.error).toBe('signIn.error.otherSignIn');
    expect(globalThis.__astraTestHost.accounts.get('antigravity')).toBeUndefined();
  });

  it('a sign-in Google gave no refresh token for says what to do about it', async () => {
    const { view } = await open((r) => (r.url.includes('/token') ? json({ access_token: 'AT', expires_in: 3600 }) : json({})));
    await view.change('address', 'plain-code');
    await view.press('finish');
    expect(view.state.error).toMatch(/refresh token/);
  });

  it('without an OAuth client the sign-in says so and cannot start', async () => {
    const view = await mount(signIn, { permissions: PERMS, config: {} });
    expect(view.find('Button').props.disabled).toBe(true);
    expect(view.findAll('Alert').some((a) => a.props.message === 'signIn.noClient')).toBe(true);
  });
});

// ---- the reply (Code Assist's { response } stream, framed by the host as sse events) ----

const wrapped = (text, extra = {}) => ({ response: { candidates: [{ content: { role: 'model', parts: [{ text }] }, ...extra }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }, traceId: 't' });
const events = (...objs) => objs.map((o) => ({ data: JSON.stringify(o), json: o }));
const run = (frames, request = {}, extra = {}) => runResponse(plugin, 'antigravity', { framing: 'sse', frames, request: { protocol: 'gemini', model: 'gemini-3-flash', stream: true, ...request }, ...extra });
const limit = (delay) => JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'exhausted your capacity on this model', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] } });

suite('the reply', () => {
  it('a streamed chunk is unwrapped, one output per event, the rest of a chunk kept', async () => {
    const r = await run(events(wrapped('Hel'), wrapped('lo', { finishReason: 'STOP' })));
    expect(r.failure).toBeNull();
    expect(r.frames).toHaveLength(2);
    expect(r.frames[0]).toEqual({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } });
    expect(r.frames[1].candidates[0].finishReason).toBe('STOP');
  });

  it('a chunk that is not an envelope passes as it is; text that is not JSON is dropped', async () => {
    expect(unwrap({ candidates: [] })).toEqual({ candidates: [] });
    expect(unwrap({ response: { candidates: [] }, traceId: 't' })).toEqual({ candidates: [] });
    const r = await run([{ data: '[DONE]' }, ...events({ candidates: [{ content: { parts: [{ text: 'x' }] } }] })]);
    expect(r.frames).toHaveLength(1);
  });

  it('a reply that is not streamed is the stream merged: text goes on text of its kind, a call stays whole', async () => {
    const r = await run(events(
      { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'think ', thought: true }] } }], modelVersion: 'm1', responseId: 'r1' } },
      { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'more', thought: true }, { text: 'Hel' }] } }] } },
      { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'lo', thoughtSignature: 'SIG' }, { functionCall: { name: 'ls', args: {} } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4 } } },
    ), { stream: false });
    expect(r.failure).toBeNull();
    expect(r.body).toEqual({
      candidates: [{ content: { role: 'model', parts: [
        { text: 'think more', thought: true }, { text: 'Hello', thoughtSignature: 'SIG' }, { functionCall: { name: 'ls', args: {} } },
      ] }, index: 0, finishReason: 'STOP' }],
      modelVersion: 'm1', responseId: 'r1', usageMetadata: { promptTokenCount: 4 },
    });
    expect(merge([]).candidates[0].content.parts).toEqual([]);
  });

  it('an error in the stream is the failure, with Google\'s words and its code', async () => {
    const r = await run(events({ error: { code: 503, message: 'overloaded' } }));
    expect(r.failure).toEqual({ status: 503, message: 'overloaded' });
    const w = await run(events(wrapped('a'), { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'exhausted your capacity on this model' } }), { stream: false });
    expect(w.failure.status).toBe(429);
    const none = await run(events({ error: { message: 'boom' } }));
    expect(none.failure).toEqual({ status: 502, message: 'boom' });
  });

  it('start: a refusal is Google\'s words under its status; a 401 passes through for the refresh', async () => {
    const lim = await run([], {}, { response: { status: 429, body: limit('12s') } });
    expect(lim.error).toEqual({ status: 429, message: 'exhausted your capacity on this model' });
    const busy = await run([], {}, { response: { status: 429, body: JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' } }) } });
    expect(busy.error.message).toMatch(/busy/);
    const v = await run([], {}, { response: { status: 403, body: JSON.stringify({ error: { message: 'verify', details: [{ metadata: { validation_url: 'https://v.example' } }] } }) } });
    expect(v.error.status).toBe(403);
    expect(v.error.message).toMatch(/verified/);
    expect((await run([], {}, { response: { status: 401, body: '{}' } })).error).toBeNull();
    expect(refusalOf(502, '')).toEqual({ status: 502, message: 'Bad Gateway' });
  });
});
