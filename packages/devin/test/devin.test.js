import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mount, runProvider } from '@astragate/plugin-sdk/testing';
import plugin, { signIn } from '../src/main.js';
import { failure } from '../src/api.js';
import { tierName } from '../src/identity.js';
import { snapshotModels } from '../src/models.js';
import { base64url, begin, challengeOf, codeOf } from '../src/signin.js';
import { SNAPSHOT, SNAPSHOT_IMAGES } from '../src/snapshot.js';
import { usageOf } from '../src/usage.js';

const manifest = JSON.parse(readFileSync(new URL('../astra.plugin.json', import.meta.url), 'utf8'));
const PERMS = manifest.permissions;
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });
const status = (extra = {}) => json({ userStatus: { email: 'Ann@Example.com', teamsTier: 'TEAMS_TIER_DEVIN_PRO', planStatus: { planInfo: {} }, ...extra } });

function fake(...replies) {
  const calls = [];
  return { calls, fn: async (req) => (calls.push(req), replies.shift() ?? { status: 500, body: {} }) };
}

describe('models', () => {
  it('offers every variant of Devin\'s list as a model, with its capabilities, and the manifest carries the same list', () => {
    const models = snapshotModels();
    expect(models.length).toBe(SNAPSHOT.flatMap((f) => f[3]).length);
    expect(models.find((m) => m.id === 'swe-2-high')).toEqual({ id: 'swe-2-high', name: 'SWE-2 High', protocol: 'chat', context: 262000, output: 128000, vision: true, reasoning: true });
    expect(models.find((m) => m.id === 'glm-5-2').vision).toBe(false); // Devin said these take no images
    expect(models.find((m) => m.id === 'gpt-6-sol-none').reasoning).toBe(false);
    expect(models.find((m) => m.id === 'claude-opus-5-5-high-fast').reasoning).toBe(true);
    expect(Object.keys(SNAPSHOT_IMAGES).length).toBe(models.length);
    expect(manifest.contributes.providers[0].models).toEqual(models);
  });

  it('answers models() with that list', async () => {
    expect(await runProvider(plugin, 'devin', 'models', null, null, { permissions: PERMS })).toEqual(snapshotModels());
  });
});

describe('chat', () => {
  it('is refused with a reason, not faked', async () => {
    await expect(runProvider(plugin, 'devin', 'prepare', { protocol: 'chat', model: 'swe-2-high', path: '/v1/chat/completions', method: 'POST', headers: {}, body: {}, stream: false }, { key: 'a', secret: 'k' }, { permissions: PERMS })).rejects.toThrow(/v1 Devin plugin/);
  });
});

describe('usage', () => {
  it('words a quota-billed plan\'s windows, ACUs and extra balance', () => {
    const out = usageOf({
      planEnd: '2026-12-01T00:00:00Z',
      planInfo: { billingStrategy: 'BILLING_STRATEGY_QUOTA' },
      dailyQuotaRemainingPercent: 60,
      dailyQuotaResetAtUnix: '1790000000',
      weeklyQuotaResetAtUnix: '1790500000',
      acuLimit: 10,
      acuConsumed: '2.5',
      overageBalanceMicros: '1500000',
    });
    expect(out.until).toBe('2026-12-01T00:00:00Z');
    expect(out.windows[0]).toMatchObject({ name: '1 day', used: 40, resetsAt: 1790000000 });
    expect(out.windows[1]).toMatchObject({ name: '7 days', used: 100 }); // a reset and no share left: used up
    expect(out.windows[2]).toMatchObject({ name: 'ACUs', used: 25, display: '2.5 / 10 ACUs', aside: true });
    expect(out.balance).toBe('$1.50');
  });

  it('asks GetUserStatus with the key and returns the card; a refused key is an error', async () => {
    const f = fake(json({ userStatus: { planStatus: { dailyQuotaRemainingPercent: 50, planInfo: {} } } }));
    const out = await runProvider(plugin, 'devin', 'usage', null, { key: 'a', secret: 'devin-session-token$X' }, { permissions: PERMS, fetch: f.fn });
    expect(f.calls[0].url).toBe('https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus');
    expect(JSON.parse(f.calls[0].body).metadata.apiKey).toBe('devin-session-token$X');
    expect(out.windows[0]).toMatchObject({ name: '1 day', used: 50 });
    const refused = fake(json({ code: 'unauthenticated', message: 'bad key' }, 401));
    await expect(runProvider(plugin, 'devin', 'usage', null, { key: 'a', secret: 'k' }, { permissions: PERMS, fetch: refused.fn })).rejects.toThrow(/expired/);
  });

  it('says Devin\'s own words for a failure', () => {
    expect(failure(200, '{"code":"unauthenticated","message":"x"}')).toEqual({ status: 401, message: 'x — sign in to Devin again' });
    expect(failure(200, '{"error":{"code":"resource_exhausted","message":"out"}}').status).toBe(429);
    expect(failure(500, '').message).toBe('Internal Server Error');
    expect(tierName('TEAMS_TIER_DEVIN_TEAMS_V2')).toBe('Devin Teams');
  });
});

describe('PKCE', () => {
  it('encodes base64url without padding and hashes the verifier like S256', () => {
    expect(base64url(new Uint8Array([251, 255, 254]))).toBe('-__-');
    expect(base64url(new Uint8Array([1]))).toBe('AQ');
    expect(base64url(new Uint8Array([1, 2]))).toBe('AQI');
    expect(challengeOf('abc')).toBe(createHash('sha256').update('abc').digest('base64url'));
  });

  it('builds the CLI\'s authorize address and reads back a pasted callback', () => {
    const b = begin();
    const q = new URL(b.url).searchParams;
    expect(b.url.startsWith('https://app.devin.ai/auth/cli/continue?')).toBe(true);
    expect(q.get('code_challenge')).toBe(challengeOf(b.verifier));
    expect(q.get('state')).toBe(b.state);
    expect(q.get('cli_pkce_marker')).toBe('1');
    expect(codeOf('http://127.0.0.1:53682/callback?code=C&state=S')).toEqual({ code: 'C', state: 'S', error: undefined });
    expect(codeOf('rawcode')).toEqual({ code: 'rawcode' });
    expect(codeOf('http://127.0.0.1:53682/callback?error=access_denied&error_description=No')).toMatchObject({ error: 'No' });
    expect(codeOf('  ')).toEqual({});
  });
});

describe('sign-in flow', () => {
  const open = (fetch) => mount(signIn, { permissions: PERMS, fetch });
  const accounts = () => globalThis.__astraTestHost.accounts.get('devin');

  it('warns that chat is not available, then offers the two ways in', async () => {
    const view = await open(fake().fn);
    expect(view.find('Alert').props.message).toBe('signIn.limit');
    expect(view.findAll('Button').map((b) => b.props.label)).toEqual(['signIn.browser.title', 'signIn.token.title']);
  });

  it('signs in with a pasted session token, naming the account as Devin does', async () => {
    const f = fake(status());
    const view = await open(f.fn);
    await view.press('token');
    await view.change('token', '  devin-session-token$K  ');
    const effects = await view.press('useToken');
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const a = accounts().get('ann@example.com');
    expect(a).toMatchObject({ displayName: 'Ann@Example.com', email: 'Ann@Example.com', plan: 'Devin Pro', secret: 'devin-session-token$K' });
  });

  it('refuses a token Devin turns away, and an empty one', async () => {
    const view = await open(fake(json({ code: 'unauthenticated', message: 'no' }, 401)).fn);
    await view.press('token');
    await view.change('token', 'bad');
    const effects = await view.press('useToken');
    expect(effects.some((e) => e.type === 'close')).toBe(false);
    expect(view.findAll('Alert')[1].props.message).toMatch(/nobody is signed in/);
    await view.change('token', '');
    expect((await view.press('useToken')).some((e) => e.type === 'fail')).toBe(true);
  });

  it('opens the browser page, exchanges the pasted callback code with the verifier, and adds the account', async () => {
    const f = fake(json({ sessionToken: 'devin-session-token$B' }), status());
    const view = await open(f.fn);
    const opened = await view.press('browser');
    const url = new URL(opened.find((e) => e.type === 'openExternal').url);
    const state = url.searchParams.get('state');
    await view.change('callback', `http://127.0.0.1:53682/callback?code=THECODE&state=${state}`);
    const effects = await view.press('finish');
    const sent = JSON.parse(f.calls[0].body);
    expect(f.calls[0].url).toBe('https://server.codeium.com/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode');
    expect(sent).toMatchObject({ code: 'THECODE', redirect_uri: 'http://127.0.0.1:53682/callback' });
    expect(challengeOf(sent.code_verifier)).toBe(url.searchParams.get('code_challenge'));
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    expect(accounts().get('ann@example.com').secret).toBe('devin-session-token$B');
  });

  it('rejects a callback from another sign-in without calling Devin', async () => {
    const f = fake();
    const view = await open(f.fn);
    await view.press('browser');
    await view.change('callback', 'http://127.0.0.1:53682/callback?code=C&state=other');
    await view.press('finish');
    expect(f.calls).toHaveLength(0);
    expect(view.findAll('Alert')[1].props.message).toBe('signIn.browser.state');
  });

  it('shows what Devin said when the exchange fails', async () => {
    const view = await open(fake({ status: 400, body: 'bad code' }).fn);
    await view.press('browser');
    await view.change('callback', 'CODE');
    await view.press('finish');
    expect(view.findAll('Alert')[1].props.message).toMatch(/exchange: 400 bad code/);
  });

  it('names an account Devin cannot name "Devin", under a key made of the token', async () => {
    const view = await open(fake(json({ userStatus: {} })).fn);
    await view.press('token');
    await view.change('token', 'tok');
    await view.press('useToken');
    const [[key, a]] = [...accounts().entries()];
    expect(key).toMatch(/^devin-[0-9a-f]{12}$/);
    expect(a.displayName).toBe('Devin');
  });
});
