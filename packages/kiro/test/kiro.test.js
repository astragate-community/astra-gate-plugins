import { describe, expect, it } from 'vitest';
import { mount, runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin, { signIn } from '../src/main.js';
import { buildKiro, imageFormat, thinking } from '../src/request.js';
import { toolID, toolName, toolNames, rememberToolNames } from '../src/tools.js';
import { failure, settleUsage, stopReason } from '../src/reply.js';
import { goG, planName, usageOf } from '../src/usage.js';
import { regionOf } from '../src/api.js';
import { fresh, refresh } from '../src/session.js';
import { MODELS } from '../src/models.js';
import { challengeOf, readAddress } from '../src/signin.js';

const PERMS = [
  'providers', 'ui',
  'net:https://runtime.us-east-1.kiro.dev', 'net:https://runtime.eu-central-1.kiro.dev',
  'net:https://management.us-east-1.kiro.dev', 'net:https://management.eu-central-1.kiro.dev',
  'net:https://prod.us-east-1.auth.desktop.kiro.dev', 'net:https://prod.eu-central-1.auth.desktop.kiro.dev',
  'net:https://oidc.us-east-1.amazonaws.com', 'net:https://oidc.eu-west-1.amazonaws.com',
];
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });
const PROFILE = 'arn:aws:codewhisperer:us-east-1:1:profile/P';
const hours = (n) => Date.now() + n * 3600_000;
const secretOf = (extra = {}) => JSON.stringify({ method: 'social', access: 'AT', refresh: 'RT', expires: hours(1), region: 'us-east-1', profile: PROFILE, ...extra });

function net(route) {
  const calls = [];
  return { calls, opts: { permissions: PERMS, fetch: async (req) => (calls.push(req), route(req)) } };
}
const account = { key: 'me@example.com' };
const messages = (extra = {}) => ({ protocol: 'anthropic', model: 'auto', path: '/v1/messages', method: 'POST', headers: {}, body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, stream: true, ...extra });
const call = (what, req, secret, route = () => json({})) => {
  const n = net(route);
  return runProvider(plugin, 'kiro', what, req, secret === undefined ? null : { ...account, secret }, n.opts).then((out) => ({ out, calls: n.calls }));
};
const build = (req, model, profile, budget) => buildKiro(req, model, profile, budget);

describe('the request', () => {
  it('buildKiro: a plain turn, the system prompt at the head, thinking announced', () => {
    const body = build({ system: 'Be brief.', messages: [{ role: 'user', content: 'hi' }] }, 'auto', 'arn:p', 20000);
    const cur = body.conversationState.currentMessage.userInputMessage;
    expect(cur.content).toBe('<thinking_mode>enabled</thinking_mode><max_thinking_length>20000</max_thinking_length>\nBe brief.\n\nhi');
    expect(cur).toMatchObject({ modelId: 'auto', origin: 'KIRO_CLI' });
    expect(body).toMatchObject({ profileArn: 'arn:p', agentMode: 'vibe' });
    expect(body.conversationState.history).toBeUndefined();
    expect(cur.images).toBeUndefined();
  });

  it('buildKiro: consecutive turns merge, history is the rest, the last is the user\'s', () => {
    const body = build({ messages: [
      { role: 'user', content: 'a' }, { role: 'user', content: 'b' },
      { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, { role: 'assistant', content: 'y' },
    ] }, 'm', '', 0);
    const s = body.conversationState;
    expect(s.history).toHaveLength(2);
    expect(s.history[0].userInputMessage.content).toBe('a\n\nb');
    expect(s.history[1].assistantResponseMessage.content).toBe('x\n\ny');
    expect(s.currentMessage.userInputMessage.content).toBe('Please proceed with the task.');
    expect(body.profileArn).toBeUndefined();
  });

  it('buildKiro: tool calls are paired with results, an unanswered call is an error result', () => {
    const body = build({ messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { a: 1 } }, { type: 'tool_use', id: 'c2', name: 'ls', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }, { type: 'tool_result', tool_use_id: 'stray', content: 'no' }] },
    ], tools: [{ name: 'read', description: 'Reads', input_schema: { type: 'object', properties: { a: {} } } }] }, 'm', '', 0);
    const cur = body.conversationState.currentMessage.userInputMessage;
    expect(cur.userInputMessageContext.toolResults).toEqual([
      { toolUseId: 'c1', status: 'success', content: [{ text: 'ok' }] },
      { toolUseId: 'c2', status: 'error', content: [{ text: 'Tool use was interrupted and did not produce a result.' }] },
    ]);
    const tools = cur.userInputMessageContext.tools.map((t) => [t.toolSpecification.name, t.toolSpecification.description]);
    expect(tools).toEqual([['read', 'Reads'], ['ls', 'Tool']]);
  });

  it('buildKiro: only the latest images are sent, as Kiro\'s bytes', () => {
    const img = (data, t = 'image/jpg') => ({ type: 'image', source: { type: 'base64', media_type: t, data } });
    const body = build({ messages: [
      { role: 'user', content: [{ type: 'text', text: '1' }, img('AAA')] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: '2' }, img('BBB', 'image/webp'), { type: 'image', source: { type: 'url', url: 'u' } }] },
    ] }, 'm', '', 0);
    expect(body.conversationState.history[0].userInputMessage.images).toBeUndefined();
    expect(body.conversationState.currentMessage.userInputMessage.images).toEqual([{ format: 'webp', source: { bytes: 'BBB' } }]);
    expect(imageFormat('image/jpg')).toBe('jpeg');
    expect(imageFormat(undefined)).toBe('png');
  });

  it('buildKiro: a conversation that opens with a stray tool result drops it', () => {
    const body = build({ messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] },
      { role: 'user', content: 'real' },
    ] }, 'm', '', 0);
    const cur = body.conversationState.currentMessage.userInputMessage;
    expect(cur.content).toBe('real');
    expect(cur.userInputMessageContext).toBeUndefined();
  });

  it('tool names and ids are made acceptable, and stably', () => {
    const long = 'mcp__plugin_' + 'x'.repeat(80) + '__tool';
    const n = toolName(long);
    expect(n.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(n)).toBe(true);
    expect(toolName(long)).toBe(n);
    expect(toolName('read_file')).toBe('read_file');
    expect(toolID('call_1')).toBe('call_1');
    expect(toolID('bad id!')).toMatch(/^t_[A-Za-z0-9_-]{32}$/);
    expect(toolID('bad id!')).toBe(toolID('bad id!'));
  });

  it('thinking: only for models that think, the budget from effort or the request', () => {
    expect(thinking({}, 'claude-sonnet')).toBe(0);
    expect(thinking({ thinking: { type: 'enabled', budget_tokens: 7000 } }, 'claude-sonnet')).toBe(7000);
    expect(thinking({ thinking: { type: 'adaptive' } }, 'auto')).toBe(20000);
    expect(thinking({ output_config: { effort: 'high' } }, 'claude-x')).toBe(30000);
    expect(thinking({ output_config: { effort: 'low' } }, 'claude-x')).toBe(0);
    expect(thinking({ thinking: { type: 'enabled' } }, 'qwen3')).toBe(0);
  });
});

describe('prepare', () => {
  it('sends the conversation to the account\'s region with kiro-cli\'s headers', async () => {
    const { out, calls } = await call('prepare', messages({ body: { model: 'auto', system: 'Be brief.', messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: 5000 } } }), secretOf());
    expect(out.url).toBe('https://runtime.us-east-1.kiro.dev/generateAssistantResponse');
    expect(out.headers).toMatchObject({ authorization: 'Bearer AT', accept: 'application/vnd.amazon.eventstream', 'x-amzn-kiro-agent-mode': 'vibe' });
    expect(out.headers.tokentype).toBeUndefined();
    expect(out.headers['user-agent']).toMatch(/^aws-sdk-rust\/1\.0\.0 .*AmazonQ-For-CLI/);
    expect(out.body.profileArn).toBe(PROFILE);
    expect(out.body.conversationState.currentMessage.userInputMessage.content).toContain('<max_thinking_length>5000</max_thinking_length>');
    expect(calls).toHaveLength(0);
  });

  it('an account of the other region goes to its own, an API key says so', async () => {
    const eu = await call('prepare', messages(), secretOf({ profile: 'arn:aws:codewhisperer:eu-central-1:1:profile/E' }));
    expect(eu.out.url).toBe('https://runtime.eu-central-1.kiro.dev/generateAssistantResponse');
    const key = await call('prepare', messages(), JSON.stringify({ method: 'apikey', access: 'ksk_x', region: 'us-east-1', profile: PROFILE }));
    expect(key.out.headers).toMatchObject({ authorization: 'Bearer ksk_x', tokentype: 'API_KEY' });
  });

  it('refreshes a token near its end, keeps the new tokens in the account', async () => {
    const { out, calls } = await call('prepare', messages(), secretOf({ expires: Date.now() + 60_000 }),
      (r) => (r.url.includes('refreshToken') ? json({ accessToken: 'AT2', refreshToken: 'RT2', expiresIn: 3600 }) : json({})));
    expect(out.headers.authorization).toBe('Bearer AT2');
    expect(calls[0].url).toBe('https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken');
    const kept = JSON.parse(globalThis.__astraTestHost.accounts.get('kiro').get('me@example.com').secret);
    expect(kept).toMatchObject({ access: 'AT2', refresh: 'RT2' });
  });

  it('an API key names its profile, once; no sign-in is a permission error', async () => {
    const key = JSON.stringify({ method: 'apikey', access: 'ksk_x', region: 'us-east-1' });
    const { out, calls } = await call('prepare', messages(), key, (r) => json({ profile: { arn: PROFILE } }));
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['X-Amz-Target']).toBe('AmazonCodeWhispererService.GetProfile');
    expect(out.body.profileArn).toBe(PROFILE);
    expect(JSON.parse(globalThis.__astraTestHost.accounts.get('kiro').get('me@example.com').secret).profile).toBe(PROFILE);
    await expect(call('prepare', messages(), 'nope')).rejects.toThrow(/sign-in is gone/);
  });

  it('answers only Anthropic Messages', async () => {
    await expect(call('prepare', messages({ protocol: 'chat' }), secretOf())).rejects.toThrow(/Messages/);
    await expect(call('prepare', messages({ path: '/v1/models' }), secretOf())).rejects.toThrow(/only answers Anthropic Messages/);
  });
});

describe('tokens', () => {
  it('fresh: keys never expire, an unknown end is fresh, a near end is not', () => {
    expect(fresh({ method: 'apikey', expires: 1 })).toBeTruthy();
    expect(fresh({ expires: 0 })).toBeTruthy();
    expect(fresh({ expires: Date.now() + 3600e3 })).toBeTruthy();
    expect(fresh({ expires: Date.now() + 60e3 })).toBeFalsy();
    expect(fresh({ expires: Date.now() + 5 * 60e3 }, 10 * 60e3)).toBeFalsy();
  });

  it('refresh: a social sign-in goes to Kiro\'s auth service and keeps the new refresh token', async () => {
    const n = net(() => json({ accessToken: 'new', refreshToken: 'r2', expiresIn: 100, profileArn: 'arn:p' }));
    const before = Date.now();
    const res = await runProvider(plugin, 'kiro', 'refresh', null, { ...account, secret: secretOf({ region: 'eu-central-1', expires: 1 }) }, n.opts);
    expect(res).toBe('renewed');
    expect(n.calls[0].url).toBe('https://prod.eu-central-1.auth.desktop.kiro.dev/refreshToken');
    expect(JSON.parse(n.calls[0].body)).toEqual({ refreshToken: 'RT' });
    expect(n.calls[0].headers['User-Agent']).toBe('Kiro-Desktop/0.2.13 (darwin; arm64)');
    const kept = JSON.parse(globalThis.__astraTestHost.accounts.get('kiro').get('me@example.com').secret);
    expect(kept).toMatchObject({ access: 'new', refresh: 'r2', profile: 'arn:p' });
    expect(kept.expires >= before + 100e3 && kept.expires < before + 110e3).toBe(true);
  });

  it('refresh: AWS (idc) uses its own endpoint, and keeps the old refresh token when none comes back', async () => {
    const n = net(() => json({ accessToken: 'a', expiresIn: 0 }));
    const secret = secretOf({ method: 'idc', region: 'us-east-1', clientId: 'ci', clientSecret: 'cs' });
    expect(await runProvider(plugin, 'kiro', 'refresh', null, { ...account, secret }, n.opts)).toBe('renewed');
    expect(n.calls[0].url).toBe('https://oidc.us-east-1.amazonaws.com/token');
    expect(JSON.parse(n.calls[0].body)).toEqual({ clientId: 'ci', clientSecret: 'cs', refreshToken: 'RT', grantType: 'refresh_token' });
    const kept = JSON.parse(globalThis.__astraTestHost.accounts.get('kiro').get('me@example.com').secret);
    expect(kept.refresh).toBe('RT');
    expect(kept.expires > Date.now() + 3500e3).toBe(true);
  });

  it('refresh: a refusal is a sign-in that is gone, other failures are not', async () => {
    const run = (status, secret = secretOf()) => runProvider(plugin, 'kiro', 'refresh', null, { ...account, secret }, net(() => json({}, status)).opts);
    expect(await run(401)).toBe('expired');
    expect(await run(503)).toBeNull();
    expect(await run(200, secretOf({ refresh: '' }))).toBe('expired');
    expect(await run(200, secretOf({ method: 'mystery' }))).toBe('expired');
    expect(await run(200, JSON.stringify({ method: 'apikey', access: 'ksk_x' }))).toBe('expired');
  });
});

describe('models and usage', () => {
  it('Auto without an account; the account\'s own list, the default first, with one', async () => {
    expect((await call('models', null)).out.map((m) => m.id)).toEqual(MODELS.map((m) => m.id));
    const list = { defaultModel: { modelId: 'claude-sonnet-4.5' }, models: [
      { modelId: 'auto', modelName: 'auto', tokenLimits: { maxInputTokens: 1000000 } },
      { modelId: 'claude-sonnet-4.5', modelName: 'Claude Sonnet 4.5', tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 }, supportedInputTypes: ['TEXT', 'IMAGE'] },
    ] };
    const got = await runProvider(plugin, 'kiro', 'models', null, { ...account, secret: secretOf() }, net(() => json(list)).opts);
    expect(got).toEqual([
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', protocol: 'anthropic', context: 200000, output: 64000, vision: true, reasoning: true },
      { id: 'auto', name: 'Auto', protocol: 'anthropic', context: 1000000, vision: false, reasoning: true },
    ]);
    const failed = await runProvider(plugin, 'kiro', 'models', null, { ...account, secret: secretOf() }, net(() => json({}, 500)).opts);
    expect(failed.map((m) => m.id)).toEqual(['auto']);
  });

  it('usageOf: credits, a running free trial, the plan and the email', () => {
    const u = usageOf({
      subscriptionInfo: { subscriptionTitle: 'KIRO PRO' },
      userInfo: { email: 'a@b.c' },
      nextDateReset: 1800000000,
      usageBreakdownList: [{
        displayNamePlural: 'Credits', currentUsageWithPrecision: 12.5, usageLimitWithPrecision: 1000,
        freeTrialInfo: { freeTrialStatus: 'active', currentUsageWithPrecision: 5, usageLimitWithPrecision: 500, freeTrialExpiry: 1700000000 },
      }],
    });
    expect(u.plan).toBe('Kiro Pro');
    expect(u.user).toBe('a@b.c');
    expect(u.windows[0]).toEqual({ name: 'Free trial', used: 1, resetsAt: new Date(1700000000e3).toISOString(), display: '5 / 500' });
    expect(u.windows[1]).toEqual({ name: 'Credits', used: 1.25, resetsAt: new Date(1800000000e3).toISOString(), display: '12.5 / 1000', span: 2592000 });
    expect(usageOf({ usageBreakdownList: [{ usageLimitWithPrecision: 0 }] }).windows).toEqual([]);
    expect(planName('kiro free')).toBe('Kiro Free');
    expect(goG(1e6)).toBe('1e+06');
    expect(goG(1000)).toBe('1000');
  });

  it('usage asks Get-Usage-Limits with the account\'s profile', async () => {
    const n = net(() => json({ subscriptionInfo: { subscriptionTitle: 'KIRO FREE' }, userInfo: { email: 'a@b.c' }, usageBreakdownList: [{ displayName: 'Credit', currentUsageWithPrecision: 1, usageLimitWithPrecision: 50 }] }));
    const u = await runProvider(plugin, 'kiro', 'usage', null, { ...account, secret: secretOf() }, n.opts);
    expect(u).toMatchObject({ plan: 'Kiro Free', user: 'a@b.c' });
    expect(u.windows[0].used).toBe(2);
    expect(n.calls[0].url).toContain('https://management.us-east-1.kiro.dev/Get-Usage-Limits?');
    expect(n.calls[0].url).toContain('profileArn=' + encodeURIComponent(PROFILE));
  });

  it('regionOf: the profile\'s region, else the nearer of Kiro\'s two', () => {
    expect(regionOf('arn:aws:codewhisperer:eu-central-1:1:profile/x', 'us-east-1')).toBe('eu-central-1');
    expect(regionOf('', 'eu-west-1')).toBe('eu-central-1');
    expect(regionOf(undefined, 'ap-south-1')).toBe('us-east-1');
  });
});

describe('signing in', () => {
  const open = async (route) => {
    const n = net(route);
    const view = await mount(signIn, n.opts);
    return { n, view };
  };
  const writtenAccounts = () => globalThis.__astraTestHost.accounts.get('kiro');

  it('reads a pasted address: its path and query', () => {
    expect(readAddress('http://localhost:3128/oauth/callback?code=c%2F1&state=S&login_option=google')).toEqual({ path: '/oauth/callback', q: { code: 'c/1', state: 'S', login_option: 'google' } });
    expect(readAddress('?code=x')).toEqual({ path: '/', q: { code: 'x' } });
    expect(readAddress('')).toBeNull();
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('saves an API key once Kiro names its profile', async () => {
    const { n, view } = await open((r) => (r.url.includes('Get-Usage-Limits') ? json({ userInfo: { email: 'k@x.y' }, subscriptionInfo: { subscriptionTitle: 'KIRO PRO' } }) : json({ profile: { arn: PROFILE } })));
    await view.change('apiKey', 'ksk_secret');
    const effects = await view.press('saveKey');
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    expect(n.calls[0].headers).toMatchObject({ Authorization: 'Bearer ksk_secret', tokentype: 'API_KEY' });
    const acc = writtenAccounts().get('k@x.y');
    expect(JSON.parse(acc.secret)).toMatchObject({ method: 'apikey', access: 'ksk_secret', profile: PROFILE });
  });

  it('a key Kiro turns down is not saved', async () => {
    const { view } = await open(() => json({}, 403));
    await view.change('apiKey', 'ksk_bad');
    const effects = await view.press('saveKey');
    expect(effects.some((e) => e.type === 'close')).toBe(false);
    expect(view.state.error).toMatch(/didn't take the API key/);
    expect(writtenAccounts()).toBeUndefined();
  });

  it('Google or GitHub: opens Kiro\'s page, trades the pasted code, names the account', async () => {
    const { n, view } = await open((r) => {
      if (r.url.includes('/oauth/token')) return json({ accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, profileArn: PROFILE });
      if (r.url.includes('Get-Usage-Limits')) return json({ userInfo: { email: 'me@x.y' }, subscriptionInfo: { subscriptionTitle: 'KIRO FREE' } });
      return json({});
    });
    const effects = await view.press('start');
    expect(effects.some((e) => e.type === 'openExternal')).toBe(true);
    expect(view.state.url).toMatch(/^https:\/\/app\.kiro\.dev\/signin\?/);
    expect(view.state.url).toContain('redirect_from=KiroIDE');
    await view.change('address', `http://localhost:3128/signin/callback?code=abc&state=${view.state.state}&login_option=github`);
    const done = await view.press('finishKiro');
    expect(done.some((e) => e.type === 'close')).toBe(true);
    const body = JSON.parse(n.calls[0].body);
    expect(body).toMatchObject({ code: 'abc', code_verifier: view.state.verifier, redirect_uri: 'http://localhost:3128/signin/callback?login_option=github' });
    expect(JSON.parse(writtenAccounts().get('me@x.y').secret)).toMatchObject({ method: 'social', loginProvider: 'Github', refresh: 'RT', profile: PROFILE });
  });

  it('Builder ID: Kiro\'s page sends on to AWS, a client is registered, the second address is traded', async () => {
    const { n, view } = await open((r) => {
      if (r.url.endsWith('/client/register')) return json({ clientId: 'cid', clientSecret: 'csec' });
      if (r.url.endsWith('/token')) return json({ accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 });
      return json({}, 403);
    });
    await view.press('start');
    await view.change('address', `http://localhost:3128/oauth/callback?state=${view.state.state}&login_option=builderid&issuer_url=https%3A%2F%2Fview.awsapps.com%2Fstart&idc_region=us-east-1`);
    const effects = await view.press('finishKiro');
    expect(effects.some((e) => e.type === 'close')).toBe(false);
    expect(view.state.step).toBe('aws');
    expect(view.state.url).toMatch(/^https:\/\/oidc\.us-east-1\.amazonaws\.com\/authorize\?/);
    expect(JSON.parse(n.calls[0].body)).toMatchObject({ clientName: 'Kiro IDE', issuerUrl: 'https://view.awsapps.com/start' });
    await view.change('address', `http://127.0.0.1:3128/oauth/callback?code=awscode&state=${view.state.aws.state}`);
    const done = await view.press('finishAws');
    expect(done.some((e) => e.type === 'close')).toBe(true);
    expect(JSON.parse(n.calls[1].body)).toMatchObject({ clientId: 'cid', grantType: 'authorization_code', code: 'awscode', redirectUri: 'http://127.0.0.1:3128/oauth/callback' });
    const [acc] = [...writtenAccounts().values()];
    expect(JSON.parse(acc.secret)).toMatchObject({ method: 'idc', builderID: true, clientId: 'cid', clientSecret: 'csec', profile: 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX' });
  });

  it('refuses another sign-in\'s address, Kiro\'s refusal, and a company identity provider', async () => {
    const { view } = await open(() => json({}));
    await view.press('start');
    await view.change('address', 'http://localhost:3128/oauth/callback?state=other&code=c&login_option=google');
    await view.press('finishKiro');
    expect(view.state.error).toBe('signIn.error.otherSignIn');
    await view.change('address', `http://localhost:3128/oauth/callback?state=${view.state.state}&error=access_denied`);
    await view.press('finishKiro');
    expect(view.state.error).toBe('signIn.error.refused');
    await view.change('address', `http://localhost:3128/oauth/callback?state=${view.state.state}&login_option=external_idp`);
    await view.press('finishKiro');
    expect(view.state.error).toBe('signIn.error.external');
    expect(writtenAccounts()).toBeUndefined();
  });
});

// ---- the reply (Kiro's AWS event stream, framed by the host: { headers, json }) ----

const ev = (type, json) => ({ headers: { ':message-type': 'event', ':event-type': type }, json });
const exc = (type, json) => ({ headers: { ':message-type': 'exception', ':exception-type': type }, json });
const reply = (frames, request = {}, extra = {}) =>
  runResponse(plugin, 'kiro', { framing: 'aws-eventstream', frames, request: { protocol: 'anthropic', model: 'm', stream: true, ...request }, ...extra });
const types = (r) => r.frames.map((f) => f.event);

describe('the reply', () => {
  it('a streamed answer is Messages events in order, a tool call with its arguments in pieces', async () => {
    const r = await reply([
      ev('assistantResponseEvent', { content: 'Hel' }),
      ev('assistantResponseEvent', { content: 'lo' }),
      ev('toolUseEvent', { toolUseId: 't1', name: 'read', input: '{"a":' }),
      ev('toolUseEvent', { toolUseId: 't1', input: '1}' }),
      ev('toolUseEvent', { toolUseId: 't1', input: {} }),
      ev('metadataEvent', { tokenUsage: { uncachedInputTokens: 7, outputTokens: 3, cacheReadInputTokens: 2 } }),
    ]);
    expect(r.failure).toBeNull();
    expect(types(r)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(r.frames[0].data.message).toMatchObject({ role: 'assistant', model: 'm' });
    expect(r.frames[2].data.delta).toEqual({ type: 'text_delta', text: 'Hel' });
    expect(r.frames[5].data.content_block).toEqual({ type: 'tool_use', id: 't1', name: 'read', input: {} });
    expect(r.frames[6].data.delta).toEqual({ type: 'input_json_delta', partial_json: '{"a":' });
    expect(r.frames.at(-2).data).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 } });
  });

  it('a non-streaming request gets one message: blocks gathered, arguments read, the caller\'s tool name restored', async () => {
    const long = 'mcp__plugin_' + 'x'.repeat(80) + '__tool';
    rememberToolNames({ tools: [{ name: long }], messages: [] });
    const short = toolName(long);
    const r = await reply([
      ev('reasoningContentEvent', { text: 't' }), ev('reasoningContentEvent', { signature: 's' }),
      ev('assistantResponseEvent', { content: 'a' }), ev('assistantResponseEvent', { content: 'b' }),
      ev('toolUseEvent', { toolUseId: 't1', name: short, input: '{"x":' }), ev('toolUseEvent', { toolUseId: 't1', input: '1}' }),
      ev('metadataEvent', { tokenUsage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheWriteInputTokens: 4 } }),
    ], { stream: false });
    expect(r.failure).toBeNull();
    expect(r.body.content).toEqual([
      { type: 'thinking', thinking: 't', signature: 's' },
      { type: 'text', text: 'ab' },
      { type: 'tool_use', id: 't1', name: long, input: { x: 1 } },
    ]);
    expect(r.body).toMatchObject({ type: 'message', stop_reason: 'tool_use', model: 'm' });
    expect(r.body.usage).toEqual({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 });
  });

  it('<thinking> in the text becomes a thinking block, however the tag falls across pieces', async () => {
    const r = await reply([ev('assistantResponseEvent', { content: '<thin' }), ev('assistantResponseEvent', { content: 'king>\nhmm</thin' }),
      ev('assistantResponseEvent', { content: 'king>\nanswer' })]);
    const blocks = r.frames.filter((f) => f.event === 'content_block_start').map((f) => f.data.content_block.type);
    expect(blocks).toEqual(['thinking', 'text']);
    const deltas = r.frames.filter((f) => f.event === 'content_block_delta').map((f) => f.data.delta);
    expect(deltas).toEqual([{ type: 'thinking_delta', thinking: 'hmm' }, { type: 'text_delta', text: 'answer' }]);
  });

  it('usage Kiro leaves out is estimated; stop reasons', async () => {
    expect(settleUsage({ input: 0, output: 0 }, 50, 200, 9)).toEqual({ input: 100, output: 3 });
    expect(settleUsage({ input: 7, output: 2 }, 50, 200, 9)).toEqual({ input: 7, output: 2 });
    expect(stopReason(0, 'MAX_TOKENS')).toBe('max_tokens');
    expect(stopReason(0, 'content_filtered')).toBe('refusal');
    expect(stopReason(2, 'max_tokens')).toBe('tool_use');
    expect(stopReason(0, '')).toBe('end_turn');
    const r = await reply([ev('assistantResponseEvent', { content: 'Hello' })], { stream: false });
    expect(r.body.usage.output_tokens).toBe(Math.floor((5 + 3) / 4));
  });

  it('an error before any answer is a status: a throttle is a 429, else a 502', async () => {
    const t = await reply([exc('throttlingException', { message: 'slow' })]);
    expect(t.failure).toEqual({ status: 429, message: 'rate limited: slow' });
    const o = await reply([exc('internalServerException', { message: 'boom' })], { stream: false });
    expect(o.failure).toEqual({ status: 502, message: 'internalServerException: boom' });
    const e = await reply([ev('serviceUnavailableError', { message: 'down' })]);
    expect(e.failure).toMatchObject({ status: 502 });
  });

  it('an error after some of the answer ends the stream with an error event, or the message with what was said', async () => {
    const s = await reply([ev('assistantResponseEvent', { content: 'part' }), exc('throttlingException', { message: 'slow' }), ev('assistantResponseEvent', { content: 'late' })]);
    expect(s.failure).toBeNull();
    expect(types(s)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'error']);
    expect(s.frames.at(-1).data.error).toEqual({ type: 'api_error', message: 'rate limited: slow' });
    const w = await reply([ev('assistantResponseEvent', { content: 'part' }), exc('throttlingException', { message: 'slow' })], { stream: false });
    expect(w.body).toMatchObject({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'part' }] });
  });

  it('start: Kiro\'s error words become a status; a 401 / 403 passes through for the refresh', async () => {
    const body = (b) => JSON.stringify(b);
    const quota = await reply([], {}, { response: { status: 500, body: body({ message: 'x', reason: 'MONTHLY_REQUEST_COUNT' }) } });
    expect(quota.error).toMatchObject({ status: 429 });
    const long = await reply([], {}, { response: { status: 400, body: body({ message: 'Input is too long', reason: 'X' }) } });
    expect(long.error).toEqual({ status: 400, message: "input is too long for the model's context: Input is too long (X)" });
    expect((await reply([], {}, { response: { status: 403, body: '{}' } })).error).toBeNull();
    expect(failure(500, 'INSUFFICIENT_MODEL_CAPACITY').status).toBe(503);
    expect(failure(502, '')).toEqual({ status: 502, message: 'Bad Gateway' });
  });

  it('toolNames maps a shortened name back', () => {
    const long = 'a'.repeat(90);
    expect([...toolNames({ tools: [{ name: long }, { name: 'ok' }], messages: [] })]).toEqual([[toolName(long), long]]);
  });
});
