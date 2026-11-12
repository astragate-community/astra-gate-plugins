import { describe, expect, it } from 'vitest';
import { mount, runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin, { signIn } from '../src/main.js';
import { refuses } from '../src/catalog.js';
import { planOf } from '../src/account.js';
import { allowanceOf, limits } from '../src/usage.js';
import { money, when } from '../src/values.js';
import { builtinModels, hostModel } from '../src/models.js';
import { fitEffort, generateBody, workPlace } from '../src/generate.js';
import { failure, streamError } from '../src/refusals.js';

const PERMS = ['providers', 'storage', 'ui', 'net:https://api.commandcode.ai'];
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });
const req = (protocol, extra = {}) => ({ protocol, model: 'm', path: '/v1/x', method: 'POST', headers: {}, body: { model: 'm', stream: true }, stream: true, ...extra });
const run = (what, request, opts = {}, account = { key: 'k1', secret: 'sk-cc' }) => runProvider(plugin, 'commandcode-plan', what, request, account, { permissions: PERMS, ...opts });
const sub = (planId) => json({ success: true, data: { planId, status: 'active', currentPeriodEnd: '2030-01-01T00:00:00Z', cancelAtPeriodEnd: false } });

describe('plans', () => {
  it("refuse the models the CLI's table says", () => {
    expect(refuses('Go', 'claude-opus-5-5')).toBe(true); // premium, Go has the open models only
    expect(refuses('Go', 'deepseek/deepseek-v4-pro')).toBe(false);
    expect(refuses('Pro', 'claude-opus-5-5')).toBe(true); // blocked for Pro
    expect(refuses('Pro', 'claude-sonnet-5')).toBe(false);
    expect(refuses('Max', 'claude-opus-5-5')).toBe(false);
    expect(refuses('No plan', 'claude-opus-5-5')).toBe(false);
  });

  it('are matched by prefix, the longest first', () => {
    expect(planOf('individual-pro-v1-x')).toEqual(['individual-pro-v1', 'Pro', 80]);
    expect(planOf('INDIVIDUAL_GO')).toEqual(['individual-go', 'Go', 10]);
    expect(planOf('zzz')).toEqual(['', '', 0]);
  });
});

describe('usage maths', () => {
  it('windows and the credits pool', () => {
    const c = {
      credits: { planId: 'individual-pro', monthlyCredits: '20', purchasedCredits: 5, freeCredits: 0 },
      windowLimits: { fiveHour: { used: 50, cap: 200, resetAt: 1_700_000_000 }, weekly: { used: 500, cap: 100 } },
    };
    const out = allowanceOf(c);
    expect(out.plan).toBe('Pro');
    expect(out.windows[0]).toEqual({ name: '5 hours', used: 25, span: 18000, resetsAt: '2023-11-14T22:13:20.000Z' });
    expect(out.windows[1].used).toBe(100); // capped
    // pool = 30 + 25 - 20 = 35; left = 25; used 10
    expect(out.windows[2]).toEqual({ name: 'Credits', used: (100 * 10) / 35, display: '$10.00 / $35.00' });
    expect(limits({ windowLimits: { weekly: { used: 1, cap: 0 } } })).toEqual([]);
  });

  it('a reply with no plan and no windows is a balance', () => {
    expect(allowanceOf({ credits: { monthlyCredits: 1.005, purchasedCredits: 2 } })).toEqual({ windows: [], balance: '$3.00' });
  });

  it('money rounds a half cent to the even cent; when reads seconds, ms and RFC 3339', () => {
    expect(money(0.125)).toBe('$0.12');
    expect(money(0.135)).toBe('$0.14');
    expect(money(-2)).toBe('$-2.00');
    expect(when(1_700_000_000)).toBe(when(1_700_000_000_000));
    expect(when('2024-01-02T03:04:05Z')).toBe('2024-01-02T03:04:05.000Z');
    expect(when('nope')).toBeUndefined();
  });
});

describe('models', () => {
  it('records say pictures only when known, and put Claude on Messages', () => {
    expect('vision' in hostModel({ id: 'a' })).toBe(false);
    expect(hostModel({ id: 'a', images: false }).vision).toBe(false);
    expect(hostModel({ id: 'claude-x' }).protocol).toBe('anthropic');
    expect(hostModel({ id: 'a', efforts: ['low'] }).reasoning).toBe(true);
    expect(builtinModels().map((m) => m.protocol)).toContain('chat');
  });

  const list = {
    data: [
      { id: 'claude-opus-5-5', supported_endpoints: ['/v1/messages'] },
      { id: 'claude-sonnet-5', supported_endpoints: ['/v1/messages'] },
      { id: 'gpt-x', supported_endpoints: ['/v1/responses'] },
      { id: 'kimi-y', supported_endpoints: ['/v1/chat/completions', '/v1/responses'], context_length: 262144, display_name: 'Kimi Y' },
    ],
  };
  const api =
    (plan, { credits = {}, models = list } = {}) =>
    async ({ url }) => {
      if (url.includes('/billing/subscriptions')) return plan ? sub(plan) : json('x', 500);
      if (url.includes('/billing/credits')) return json({ credits });
      return json(models);
    };

  it("cuts the Provider API's list by what the plan refuses, each model on its own API", async () => {
    const out = await run('models', null, { fetch: api('individual-pro') });
    expect(out).toEqual([
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', protocol: 'anthropic', context: 1000000, vision: true },
      { id: 'gpt-x', name: 'gpt-x', protocol: 'responses' },
      { id: 'kimi-y', name: 'Kimi Y', protocol: 'chat', context: 262144 },
    ]);
  });

  it('lets an account with credits beyond its plan every model', async () => {
    const out = await run('models', null, { fetch: api('individual-pro', { credits: { purchasedCredits: 5 } }) });
    expect(out.map((m) => m.id)).toContain('claude-opus-5-5');
  });

  it('keeps the whole list when the plan cannot be read, and the saved plan when it can', async () => {
    expect((await run('models', null, { fetch: api(null) })).map((m) => m.id)).toContain('claude-opus-5-5');
    const saved = await run('models', null, { fetch: api(null), storage: { 'plan.k1': { id: 'individual-pro', plan: 'Pro' } } });
    expect(saved.map((m) => m.id)).not.toContain('claude-opus-5-5');
  });

  it('falls back to the built-in list (cut the same way) when the list fails, and offers it without an account', async () => {
    const down = async ({ url }) => (url.includes('/billing/subscriptions') ? sub('individual-pro') : json('x', 500));
    const out = await run('models', null, { fetch: down });
    expect(out.map((m) => m.id)).toEqual(['claude-sonnet-5', 'gpt-6-sol', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'moonshotai/Kimi-K3', 'zai-org/GLM-5.3', 'MiniMaxAI/MiniMax-M3']);
    expect((await run('models', null, {}, null)).length).toBe(builtinModels().length);
  });

  it('lists nothing for a Go key', async () => {
    expect(await run('models', null, { fetch: api('individual-go') })).toEqual([]);
  });
});

describe('prepare', () => {
  it('sends each protocol to the Provider API with the key both ways', async () => {
    const chat = await run('prepare', req('chat'));
    expect(chat).toEqual({ url: 'https://api.commandcode.ai/provider/v1/chat/completions', headers: { Authorization: 'Bearer sk-cc', 'x-api-key': 'sk-cc' } });
    expect((await run('prepare', req('responses'))).url).toBe('https://api.commandcode.ai/provider/v1/responses');
    expect((await run('prepare', req('anthropic'))).url).toBe('https://api.commandcode.ai/provider/v1/messages');
  });

  it('refuses gemini, a missing account, and a Go key', async () => {
    await expect(run('prepare', req('gemini'))).rejects.toThrow(/gemini/);
    await expect(run('prepare', req('chat'), {}, null)).rejects.toThrow(/needs an account/);
    await expect(run('prepare', req('chat'), { storage: { 'plan.k1': { id: 'individual-go', plan: 'Go' } } })).rejects.toThrow(/Go plan has no Provider API/);
  });
});

describe('usage', () => {
  const credits = { credits: { monthlyCredits: 20, purchasedCredits: 0, freeCredits: 0 }, windowLimits: { weekly: { used: 10, cap: 100 } } };
  it("returns the plan's windows and period, and saves the plan on the account", async () => {
    const out = await run('usage', null, { fetch: async ({ url }) => (url.includes('/billing/subscriptions') ? sub('individual-pro') : json(credits)) });
    expect(out.plan).toBe('Pro');
    expect(out.until).toBe('2030-01-01T00:00:00.000Z');
    expect(out.renew).toBe('auto');
    expect(out.windows[0]).toMatchObject({ name: 'Weekly', used: 10 });
    expect(globalThis.__astraTestHost.accounts.get('commandcode-plan').get('k1').plan).toBe('Pro');
    expect(JSON.parse(globalThis.__astraTestHost.storage.get('plan.k1'))).toEqual({ id: 'individual-pro', plan: 'Pro' });
  });

  it('still says the plan when the credits cannot be read', async () => {
    const out = await run('usage', null, { fetch: async ({ url }) => (url.includes('/billing/subscriptions') ? sub('individual-max') : json('x', 503)) });
    expect(out).toMatchObject({ plan: 'Max', error: 'Service Unavailable', windows: [] });
  });
});

describe('sign-in flow', () => {
  const api =
    (plan, whoamiStatus = 200) =>
    async ({ url }) => {
      if (url.includes('/alpha/whoami')) return json({ user: { id: 'u1', userName: 'ann', email: 'ann@x.io' } }, whoamiStatus);
      if (url.includes('/billing/subscriptions')) return sub(plan);
      return json('no', 404);
    };
  const submit = async (fetch, key = ' sk-new ') => {
    const view = await mount(signIn, { permissions: PERMS, fetch });
    await view.change('apiKey', key);
    return { view, effects: await view.press('save') };
  };

  it('names the key with whoami, reads its plan and adds the account', async () => {
    const { effects } = await submit(api('individual-pro'));
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const acc = globalThis.__astraTestHost.accounts.get('commandcode-plan').get('u1');
    expect(acc).toMatchObject({ key: 'u1', displayName: 'ann', email: 'ann@x.io', plan: 'Pro', secret: 'sk-new' });
  });

  it('adds a Go key to the Go provider, not the Provider API one', async () => {
    const { effects } = await submit(api('individual-go'));
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    expect(globalThis.__astraTestHost.accounts.get('commandcode-go').get('u1')).toMatchObject({ key: 'u1', plan: 'Go', secret: 'sk-new' });
    expect(globalThis.__astraTestHost.accounts.get('commandcode-plan')?.size ?? 0).toBe(0);
  });

  it('refuses a key whoami turns down and an empty one', async () => {
    const a = await submit(api('individual-pro', 401));
    expect(a.effects.some((e) => e.type === 'close')).toBe(false);
    const c = await submit(api('individual-pro'), '  ');
    expect(c.effects.some((e) => e.type === 'close')).toBe(false);
    expect(globalThis.__astraTestHost.accounts.get('commandcode-plan')?.size ?? 0).toBe(0);
  });
});

// ---- the Go plan: /alpha/generate in the CLI's format, its NDJSON reply as chat completion chunks

const runGo = (what, request, opts = {}, account = { key: 'g1', secret: 'sk-go' }) => runProvider(plugin, 'commandcode-go', what, request, account, { permissions: PERMS, ...opts });
const line = (o) => ({ json: o });
const goReply = (frames, request = {}, response = {}) =>
  runResponse(plugin, 'commandcode-go', { framing: 'ndjson', frames, request: { protocol: 'chat', stream: true, model: 'deepseek/deepseek-v4-pro', ...request }, response }, { permissions: PERMS });
const FINISH = { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 3 }, outputTokenDetails: { reasoningTokens: 2 } } };

describe('Go request', () => {
  it("writes a chat completion in the CLI's format", () => {
    const body = generateBody(
      {
        model: 'deepseek/deepseek-v4-pro',
        reasoning_effort: 'medium',
        temperature: 0.5,
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'developer', content: [{ type: 'text', text: 'and kind' }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            ],
          },
          { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'ls', arguments: '{"p":1}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: 'a b' },
        ],
        tools: [{ type: 'function', function: { name: 'ls', parameters: { type: 'object' } } }, { type: 'other' }],
      },
      { dir: '/work', git: 'yes' },
    );
    expect(body.config.workingDir).toBe('/work');
    expect(body.config.isGitRepo).toBe(true);
    expect(body.params.system).toBe('be brief\n\nand kind');
    expect(body.params.max_tokens).toBe(64000);
    expect(body.params.reasoning_effort).toBe('high'); // deepseek-v4-pro has high, max: the higher of the tie
    expect(body.params.temperature).toBe(0.5);
    expect(body.params.tools).toEqual([{ name: 'ls', description: '', input_schema: { type: 'object' } }]);
    expect(body.params.messages[0].content[1]).toEqual({ type: 'image', image: 'data:image/png;base64,AAA', mimeType: 'image/png' });
    expect(body.params.messages[1].content).toEqual([{ type: 'tool-call', toolCallId: 'c1', toolName: 'ls', input: { p: 1 } }]);
    expect(body.params.messages[2]).toEqual({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'ls', output: { type: 'text', value: 'a b' } }] });
  });

  it("fits a reasoning effort to the levels a model has, and reads magpie's work headers", () => {
    expect(fitEffort('medium', ['low', 'high', 'max'])).toBe('high');
    expect(fitEffort('ultra', ['low', 'high'])).toBe('high');
    expect(fitEffort('xhigh', [])).toBe('xhigh');
    expect(workPlace({ 'x-magpie-work-dir': encodeURIComponent('/a b'), 'x-magpie-work-git': 'no' })).toEqual({ dir: '/a b', git: 'no' });
    expect(workPlace({}).dir).toBeUndefined();
    expect(generateBody({ model: 'm', messages: [] }).config.workingDir).toBe('~');
  });

  it("prepare sends it to /alpha/generate with the CLI's headers and the key", async () => {
    const out = await runGo('prepare', { ...req('chat'), model: 'moonshotai/Kimi-K3', body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] }, headers: { 'x-magpie-work-dir': '%2Fw' } });
    expect(out.url).toBe('https://api.commandcode.ai/alpha/generate');
    expect(out.headers).toMatchObject({ Authorization: 'Bearer sk-go', 'x-command-code-version': '1.72.2', 'User-Agent': 'cli' });
    expect(out.body.params.model).toBe('moonshotai/Kimi-K3');
    expect(out.body.config.workingDir).toBe('/w');
    await expect(runGo('prepare', req('anthropic'))).rejects.toThrow(/chat completions only/);
    await expect(runGo('prepare', req('chat'), {}, null)).rejects.toThrow(/needs an account/);
  });
});

describe('Go models', () => {
  it("is the Provider API's list asked without the key, less what Go is refused, with the CLI's table filling in", async () => {
    const seen = [];
    const out = await runGo('models', null, {
      fetch: async (r) => {
        seen.push(r);
        if (r.url.includes('/billing/credits')) return json({ credits: { purchasedCredits: 0, freeCredits: 0 } });
        return json({ data: [{ id: 'claude-opus-5-5' }, { id: 'deepseek/deepseek-v4-pro', context_length: 0 }, { id: 'some/image-gen' }, { id: 'moonshotai/Kimi-K3', display_name: 'K3' }] });
      },
    });
    expect(out.map((m) => m.id)).toEqual(['deepseek/deepseek-v4-pro', 'moonshotai/Kimi-K3']);
    expect(out[0]).toMatchObject({ protocol: 'chat', name: 'DeepSeek V4 Pro', context: 1000000, reasoning: true });
    expect(out[1].name).toBe('K3');
    expect(seen.find((r) => r.url.endsWith('/provider/v1/models')).headers.Authorization).toBeUndefined();
  });

  it('falls back to the CLI table (cut for Go) when the list fails', async () => {
    const out = await runGo('models', null, { fetch: async () => json('x', 500) });
    expect(out.map((m) => m.id)).toContain('deepseek/deepseek-v4-pro');
    expect(out.map((m) => m.id)).not.toContain('claude-opus-5-5');
  });
});

describe('Go reply', () => {
  const chatLines = [
    line({ type: 'reasoning-delta', text: 'hm' }),
    line({ type: 'text-delta', text: 'Hel' }),
    line({ type: 'text-delta', text: 'lo' }),
    line({ type: 'tool-call', toolCallId: 't1', toolName: 'ls', input: { a: 1 } }),
    line({ type: 'tool-call', toolCallId: 't2', toolName: 'srv', providerExecuted: true }),
    line({ type: 'cache-write-tokens', cacheWriteTokens: 7 }),
    line(FINISH),
  ];

  it('streams chunks: a role chunk first, then reasoning, text, whole tool calls and the finish with usage', async () => {
    const out = await goReply(chatLines);
    expect(out.failure).toBeNull();
    const d = out.frames.map((f) => f.choices[0]);
    expect(d[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(d[1].delta).toEqual({ reasoning_content: 'hm' });
    expect(d[2].delta.content + d[3].delta.content).toBe('Hello');
    expect(d[4].delta.tool_calls).toEqual([{ index: 0, id: 't1', type: 'function', function: { name: 'ls', arguments: '{"a":1}' } }]);
    expect(d[5].finish_reason).toBe('tool_calls'); // a tool call turns a plain stop into one
    expect(out.frames[5].usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
    expect(out.frames).toHaveLength(6);
  });

  it('folds the same lines into one chat.completion for a caller that did not ask for a stream', async () => {
    const out = await goReply(chatLines, { stream: false });
    expect(out.failure).toBeNull();
    expect(out.body).toMatchObject({ object: 'chat.completion', model: 'deepseek/deepseek-v4-pro', usage: { total_tokens: 15 } });
    expect(out.body.choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: { role: 'assistant', content: 'Hello', reasoning_content: 'hm', tool_calls: [{ id: 't1', type: 'function', function: { name: 'ls', arguments: '{"a":1}' } }] },
    });
    const len = await goReply([line({ type: 'text-delta', text: 'x' }), line({ type: 'finish', finishReason: 'length', totalUsage: { inputTokens: 1, outputTokens: 2 } })], { stream: false });
    expect(len.body.choices[0].finish_reason).toBe('length');
    expect(len.body.usage.total_tokens).toBe(3);
  });

  it('ends a reply cut short with a note and a finish when it said something, else an error', async () => {
    const cut = await goReply([line({ type: 'text-delta', text: 'part' })]);
    expect(cut.failure).toBeNull();
    expect(cut.frames.at(-2).choices[0].delta.content).toMatch(/\(The reply was cut short/);
    expect(cut.frames.at(-2).choices[0].delta.content.startsWith('\n\n')).toBe(true);
    expect(cut.frames.at(-1).choices[0].finish_reason).toBe('stop');
    const none = await goReply([line({ type: 'cache-write-tokens', cacheWriteTokens: 1 })]);
    expect(none.failure).toEqual({ status: 502, message: 'the reply ended before it was complete' });
  });

  it('keeps the status of a reply that fails straight away, and writes an error block after it began', async () => {
    const first = await goReply([line({ type: 'error', error: { message: 'bad', statusCode: 402 } })]);
    expect(first.failure).toEqual({ status: 402, message: 'bad' });
    const later = await goReply([line({ type: 'text-delta', text: 'x' }), line({ type: 'error', error: '429 {"error":{"message":"slow"}}' })]);
    expect(later.failure).toBeNull();
    expect(later.frames.at(-1)).toEqual({ error: { message: 'slow', code: 429 } });
  });

  it("maps Command Code's refusals to the status they stand for", async () => {
    const r = (status, body) => goReply([], {}, { status, headers: {}, body });
    expect((await r(400, JSON.stringify({ error: { message: 'MODEL_NOT_IN_PLAN: Claude Opus 5.5' } }))).error).toEqual({ status: 403, message: 'Model not in plan: Claude Opus 5.5' });
    expect((await r(400, 'PREMIUM_CREDITS_EXHAUSTED: none left')).error).toEqual({ status: 402, message: 'out of credits: none left' });
    expect((await r(500, 'RATE_LIMITED')).error.status).toBe(429);
    expect((await r(429, '')).error).toEqual({ status: 429, message: 'Too Many Requests' });
    expect(failure(200, 'x').status).toBe(502);
    expect(streamError({ message: 'Stream error' })).toEqual({ status: 500, message: 'Stream error' });
  });

  it('skips lines it cannot read and nothing after the finish', async () => {
    const out = await goReply([{ text: 'garbage' }, line({ type: 'text-delta', text: 'a' }), line(FINISH), line({ type: 'text-delta', text: 'late' })]);
    expect(out.frames.map((f) => f.choices[0].delta.content).filter(Boolean)).toEqual(['a']);
  });
});

describe('a Go key the plan was not known for', () => {
  it('is added to the Go provider when the Provider API refuses it', async () => {
    const acct = { key: 'k9', secret: 'sk-9' };
    const out = await run('refresh', { status: 403, body: "Your Go plan doesn't include API access. Upgrade to Provider" }, {}, acct);
    expect(out).toBe('expired');
    expect(globalThis.__astraTestHost.accounts.get('commandcode-go').get('k9')).toMatchObject({ secret: 'sk-9' });
    expect(await run('refresh', { status: 401, body: 'nope' }, {}, acct)).toBeFalsy();
  });
});
