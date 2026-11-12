import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { mount, runProvider, runResponse } from '@astragate/plugin-sdk/testing';
import plugin, { signIn } from '../src/main.js';
import { SITES, chatBase, siteOf } from '../src/constants.js';
import { AccountRefused, checked, signed } from '../src/api.js';
import { MODELS, builtinModels, liveModels, parseModels } from '../src/models.js';
import { SignInExpired, freshOf, latest, renew, renewed, renewing, token } from '../src/session.js';
import { challengeOf, pollDevice, signedInResult, startDevice } from '../src/signin.js';
import { credits, membership, membershipOf, planWindows, usageOf } from '../src/usage.js';
import { transformResponse, QUOTA } from '../src/reply.js';

const PERMS = ['providers', 'ui', ...Object.values(SITES).flatMap((s) => [s.account, s.llm, s.agent, s.platform].map((o) => 'net:' + o))];
const cn = SITES['minimax-code'];
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body });
const raw = (body, status = 200) => ({ status, headers: {}, body });
const md5 = (s) => createHash('md5').update(s).digest('hex');
const jwtOf = (claims) => 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
const stored = (o = {}) => ({ access: 'A0', refresh: 'R0', expires: Date.now() + 3600e3, ...o });
const tokenAnswer = (access, refresh) => json({ access_token: access, refresh_token: refresh, expires_in: 3600 });
const form = (body) => Object.fromEntries(new URLSearchParams(body));

// the in-memory host the SDK installs; unit tests point its fetch at a queue (or a function by url) and record the calls
const host = () => globalThis.__astraTestHost;
function fake(...replies) {
  const calls = [];
  const h = host();
  h.granted = new Set(PERMS);
  h.accounts = new Map();
  h.fetch = async (req) => {
    calls.push(req);
    return typeof replies[0] === 'function' ? replies[0](req.url, req) : replies.shift();
  };
  return calls;
}
beforeEach(() => {
  renewed.clear();
  renewing.clear();
});

describe('sites', () => {
  it('has the chat base of each site, and finds a site by the host row id too', () => {
    expect(chatBase(SITES['minimax-code-global'])).toBe('https://agent.minimax.io/mavis/api/v1/llm/v1');
    expect(chatBase(cn)).toBe('https://agent.minimax.cn/mavis/api/v1/llm/v1');
    expect(siteOf('minimax-code-global').id).toBe('minimax-code-global');
    expect(siteOf('plugin2-astragate-community-minimax-minimax-code').id).toBe('minimax-code');
    expect(siteOf('plugin2-astragate-community-minimax-minimax-code-global').id).toBe('minimax-code-global');
    expect(siteOf(undefined).id).toBe('minimax-code');
  });
});

describe('signed account requests', () => {
  it('signs a GET over "{}" and the time', () => {
    const now = 1700000000123;
    const { url, init } = signed(cn, '/v1/api/user/info', { access: 'AT', now, tz: 28800, platform: 'linux' });
    const u = new URL(url);
    expect(u.origin).toBe('https://agent.minimaxi.com');
    expect(u.searchParams.get('user_id')).toBe('0');
    expect(u.searchParams.get('timezone_offset')).toBe('28800');
    expect(u.searchParams.get('lang')).toBe('zh');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const ts = Math.floor(now / 1000);
    expect(init.headers['x-timestamp']).toBe(String(ts));
    expect(init.headers['x-signature']).toBe(md5(ts + 'I*7Cf%WZ#S&%1RlZJ&C2'));
    expect(init.headers.yy).toBe(md5(`${encodeURIComponent(u.pathname + u.search)}_{}${md5(String(now))}ooui`));
    expect(init.headers.Authorization).toBe('Bearer AT');
  });

  it('signs a POST over its body too and carries the user id', () => {
    const now = 1700000000000;
    const { url, init } = signed(SITES['minimax-code-global'], '/x', { access: 'AT', userID: ' 42 ', body: { a: 1 }, now, tz: 0 });
    const u = new URL(url);
    expect(u.searchParams.get('user_id')).toBe('42');
    expect(u.searchParams.get('lang')).toBe('en');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    const ts = Math.floor(now / 1000);
    expect(init.headers['x-signature']).toBe(md5(`${ts}I*7Cf%WZ#S&%1RlZJ&C2{"a":1}`));
    expect(init.headers.yy).toBe(md5(`${encodeURIComponent(u.pathname + u.search)}_{"a":1}${md5(String(now))}ooui`));
  });

  it("reads the account API's failures", () => {
    expect(checked({ ok: 1 }, 'x')).toEqual({ ok: 1 });
    expect(() => checked({ statusInfo: { code: 1000048 } }, 'x')).toThrow(AccountRefused);
    expect(() => checked({ statusInfo: { code: 5, message: 'bad' } }, 'x')).toThrow(/x: bad/);
    expect(() => checked({ statusInfo: { code: 5 } }, 'x')).toThrow(/status 5/);
    expect(() => checked({ base_resp: { status_code: 2, status_msg: 'nope' } }, 'x')).toThrow(/x: nope/);
    expect(checked({ statusInfo: { code: 0 }, base_resp: { status_code: 0 } }, 'x').statusInfo).toEqual({ code: 0 });
  });
});

describe('models', () => {
  it('lists the built-in models for the host', () => {
    expect(builtinModels().map((m) => m.id)).toEqual(MODELS.map((m) => m.id));
    expect(builtinModels()[1]).toMatchObject({ id: 'MiniMax-M3', protocol: 'anthropic', vision: true, reasoning: true, context: 512000, output: 128000 });
    expect(builtinModels()[2].vision).toBe(false);
  });

  it("parses MiniMax Code's model config", () => {
    const body = {
      providers: [
        { providerId: 'other', config: { models: { x: {} } } },
        {
          providerId: 'minimax',
          config: {
            model_order: ['b', 'ghost'],
            models: {
              a: { name: 'A', limit: { context: '1000', output: 10 }, modalities: { input: ['text', 'image'] }, thinking_config: { mode: 'switchable' } },
              b: { thinking_config: { mode: 'forced_on' }, thinking: { effortOptions: ['default', 'none', 'low', 3, 'high'] }, attachment: true },
              c: { reasoning: false },
              ' ': {},
            },
          },
        },
      ],
    };
    const ms = parseModels(body);
    expect(ms.map((m) => m.id)).toEqual(['b', 'a', 'c']);
    expect(ms[0]).toEqual({ id: 'b', name: 'b', context: 0, output: 0, images: true, thinking: 'forced_on', efforts: ['low', 'high'] });
    expect(ms[1].context).toBe(1000);
    expect(ms[1].thinking).toBe('switchable');
    expect(ms[2].thinking).toBe('off');
    expect(parseModels({})).toEqual([]);
    expect(parseModels({ providers: [{ providerId: 'minimax' }] })).toEqual([]);
  });

  it('retries the live list without the account when it is refused', async () => {
    const calls = fake(raw('', 401), json({ providers: [{ providerId: 'minimax', config: { models: { m: {} } } }] }));
    const ms = await liveModels(cn, 'AT');
    expect(ms[0].id).toBe('m');
    expect(calls[0].headers.Authorization).toBe('Bearer AT');
    expect(calls[1].headers.Authorization).toBeUndefined();
    expect(calls[0].url).toBe('https://agent.minimax.cn/mavis/api/v1/models?region=cn&buildEnv=prod');
    fake(raw('', 500));
    await expect(liveModels(cn, 'AT')).rejects.toThrow(/MiniMax Code's models: HTTP 500/);
  });

  describe('provider.models', () => {
    const acct = { key: '42', secret: JSON.stringify(stored()) };
    const models = (fetch, account = acct) => runProvider(plugin, 'minimax-code', 'models', null, account, { permissions: PERMS, fetch });

    it('is the built-in list without an account, or when the live one fails', async () => {
      expect(await models(async () => raw('', 500), null)).toEqual(builtinModels());
      expect(await models(async () => raw('', 500))).toEqual(builtinModels());
    });

    it("is MiniMax Code's live list when it answers", async () => {
      const got = await models(async () => json({ providers: [{ providerId: 'minimax', config: { models: { m: { name: 'M', limit: { context: 9, output: 3 }, attachment: true } } } }] }));
      expect(got).toEqual([{ id: 'm', name: 'M', protocol: 'anthropic', context: 9, output: 3, vision: true, reasoning: true }]);
    });
  });
});

describe('the usage card', () => {
  it('says a count of credits', () => {
    expect(credits('1234.50')).toBe('1234.5 credits');
    expect(credits('10')).toBe('10 credits');
    expect(credits(3.14159)).toBe('3.14 credits');
    expect(credits('x')).toBe('x');
  });

  it('reads both membership shapes', () => {
    expect(membershipOf({ has_token_plan: true, token_plan_tier: ' Plus ', token_plan_expires_at: '1800000000', op_group_id: 'g', op_credit_summary: { total_remaining_amount: '5' } })).toEqual({
      hasTokenPlan: true, opGroupId: 'g', tier: 'Plus', expiresAt: 1800000000, balance: '5',
    });
    expect(membershipOf({ data: { has_token_plan: false, opcredit_balance: 7 } })).toEqual({ hasTokenPlan: false, balance: '7' });
    expect(membershipOf(undefined)).toEqual({});
  });

  it('names the plan', () => {
    expect(usageOf({})).toEqual({ plan: 'Free', windows: [] });
    expect(usageOf({ hasTokenPlan: true }).plan).toBe('M Plan');
    expect(usageOf({ hasTokenPlan: true, tier: 'Pro', expiresAt: 1800000000, balance: '2.50' }, [1])).toEqual({ plan: 'M Plan Pro', until: '2027-01-15T08:00:00.000Z', balance: '2.5 credits', windows: [1] });
    expect(usageOf({ hasTokenPlan: true, expiresAt: 1800000000000 }).until).toBe('2027-01-15T08:00:00.000Z');
    expect(usageOf({ hasTokenPlan: false, expiresAt: 1800000000 }).until).toBeUndefined();
  });

  it("reads the plan's intervals and weeks", () => {
    const H = 3600_000;
    const ws = planWindows({
      base_resp: { status_code: 0 },
      model_remains: [
        { model_name: 'general', current_interval_remaining_percent: 40, current_interval_status: 1, start_time: 1700000000000, end_time: 1700000000000 + 5 * H, current_weekly_remaining_percent: 90, current_weekly_status: 1, weekly_end_time: 1700000000 },
        { model_name: 'video', current_interval_status: 2, start_time: 1700000000, end_time: 1700000000 + 1800, current_weekly_status: 3 },
        { model_name: 'dead', current_interval_status: 3, current_weekly_status: 3, current_interval_total_count: 0, current_weekly_total_count: '0' },
        { model_name: ' ' },
      ],
    });
    expect(ws).toHaveLength(3);
    expect(ws[0]).toEqual({ used: 60, span: 5 * 3600, resetsAt: new Date(1700000000000 + 5 * H).toISOString(), name: '5 hours' });
    expect(ws[1]).toMatchObject({ name: '7 days', used: 10, span: 7 * 86400 });
    expect(ws[2]).toMatchObject({ name: 'Video · 30 minutes', used: 100, aside: true });
  });

  it('refuses a reply without a plan', () => {
    expect(() => planWindows({})).toThrow(/no plan in the reply/);
    expect(() => planWindows({ base_resp: { status_code: 9, status_msg: 'bad' } })).toThrow(/bad/);
    expect(() => planWindows({ base_resp: { status_code: 9 } })).toThrow(/MiniMax said 9/);
    expect(planWindows({ base_resp: { status_code: 0 } })).toEqual([]);
  });

  const ok = (extra) => json({ statusInfo: { code: 0 }, ...extra });

  it('joins the workspace and the membership answers', async () => {
    const calls = fake(
      ok({ workspaces: [{ workspace_type: 1, workspace_id: 9 }, { workspace_type: 0, workspace_id: 7, op_group_id: 'g7' }] }),
      ok({ has_token_plan: true, token_plan_tier: 'Max', opcredit_balance: '12' }),
    );
    expect(await membership(cn, 'AT', 'u')).toEqual({ opGroupId: 'g7', hasTokenPlan: true, tier: 'Max', balance: '12' });
    expect(JSON.parse(calls[1].body)).toEqual({ workspace_id: 7 });
  });

  it('falls back to the membership answer alone, and passes a refusal on', async () => {
    fake(raw('', 500), json({ has_token_plan: false }));
    expect(await membership(cn, 'AT', 'u')).toEqual({ hasTokenPlan: false });
    fake(raw('', 401));
    await expect(membership(cn, 'AT', 'u')).rejects.toBeInstanceOf(AccountRefused);
    fake(json({ workspaces: [] }));
    expect(await membership(cn, 'AT', 'u')).toEqual({});
  });

  describe('provider.usage', () => {
    const usage = (fetch, secret = stored()) => runProvider(plugin, 'minimax-code', 'usage', null, { key: '42', secret: JSON.stringify(secret) }, { permissions: PERMS, fetch });

    it('reports an expired sign-in, and marks the account', async () => {
      const r = await usage(async () => raw('', 500), stored({ refresh: '', expires: Date.now() - 1 }));
      expect(r.signIn).toBe('expired');
      expect(host().accounts.get('minimax-code').get('42').status).toBe('expired');
    });

    it("builds the card from the account's plan and windows", async () => {
      const r = await usage(async ({ url }) => {
        if (url.includes('/v1/api/user/info')) return ok({ data: { userInfo: { realUserID: '42', email: 'me@x' } } });
        if (url.includes('get_user_extra_info')) return ok({ workspaces: [{ workspace_type: 0, workspace_id: 1 }] });
        if (url.includes('get_membership_info')) return ok({ has_token_plan: true, token_plan_tier: 'Pro', op_group_id: 'g', opcredit_balance: '8' });
        if (url.includes('coding_plan/remains')) return json({ base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_remaining_percent: 75, current_interval_status: 1, start_time: 1700000000, end_time: 1700000000 + 18000 }] });
        return raw('', 404);
      });
      expect(r).toMatchObject({ plan: 'M Plan Pro', balance: '8 credits', user: 'me@x', signIn: 'kept' });
      expect(r.windows[0].used).toBe(25);
      expect(r.error).toBeUndefined();
    });

    it("keeps the card when only the plan's windows fail", async () => {
      const r = await usage(async ({ url }) => (url.includes('get_user_extra_info') ? ok({ workspaces: [] }) : url.includes('coding_plan') ? raw('', 500) : ok({})), stored({ realUserID: '42', name: 'N' }));
      expect(r).toMatchObject({ plan: 'Free', user: 'N' });
    });

    it('reports a failed account call and keeps the sign-in', async () => {
      expect(await usage(async () => raw('', 500))).toEqual({ error: 'account: HTTP 500', signIn: 'kept' });
    });
  });
});

describe('device sign-in', () => {
  it('reads the standard device answer', async () => {
    const calls = fake(json({ device_code: 'D', user_code: 'U', verification_uri: 'https://v', verification_uri_complete: 'https://v?c=U', expires_in: 100, interval: 2 }));
    const d = await startDevice(cn);
    expect(calls[0].url).toBe('https://account.minimax.cn/oauth2/device/code');
    const f = form(calls[0].body);
    expect(f.client_id).toBe('mcode-public');
    expect(f.code_challenge).toBe(createHash('sha256').update(d.verifier).digest('base64url'));
    expect(f.code_challenge_method).toBe('S256');
    expect(d.poll).toEqual({ device_code: 'D' });
    expect(d.url).toBe('https://v?c=U');
    expect(d.intervalMs).toBe(2000);
    expect(d.deadline).toBeGreaterThan(Date.now() + 99000);
  });

  it('makes S256 challenges as PKCE says', () => {
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it("reads MiniMax's own variant (user code polled, interval in ms)", async () => {
    fake(json({ user_code: 'U', verification_url: 'https://v', expired_in: Date.now() + 60000, interval: 1500 }));
    const d = await startDevice(cn);
    expect(d.poll).toEqual({ user_code: 'U' });
    expect(d.intervalMs).toBe(1500);
    expect(d.url).toBe('https://v');
    expect(d.deadline).toBeGreaterThan(Date.now() + 50000);
    expect(d.deadline).toBeLessThan(Date.now() + 61000);
  });

  it('refuses an incomplete or failed answer', async () => {
    fake(json({ user_code: 'U', verification_uri: 'https://v' }));
    await expect(startDevice(cn)).rejects.toThrow(/invalid_device_authorization_response/);
    fake(json({ error: 'invalid_client' }, 400));
    await expect(startDevice(cn)).rejects.toThrow(/invalid_client \(HTTP 400\)/);
    fake(raw('<html>', 502));
    await expect(startDevice(cn)).rejects.toThrow(/invalid_json_response \(HTTP 502\)/);
  });

  const device = (o = {}) => ({ intervalMs: 0, deadline: Date.now() + 5000, verifier: 'V', poll: { device_code: 'D' }, ...o });

  it('waits through pending, then returns the token', async () => {
    const calls = fake(json({ status: 'pending' }), json({ error: 'authorization_pending' }, 400), json({ access_token: 'A', refresh_token: 'R', expires_in: 60 }));
    const t = await pollDevice(cn, device());
    expect(t.access).toBe('A');
    expect(calls).toHaveLength(3);
    expect(form(calls[0].body)).toMatchObject({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'D', code_verifier: 'V' });
  });

  it('slows down when told to, and gives up a slice with the device still good', async () => {
    fake(json({ status: 'slow_down' }));
    const d = device({ intervalMs: 1 });
    expect(await pollDevice(cn, d, 3000)).toBeNull();
    expect(d.intervalMs).toBe(5001);
  });

  it('ends on a refusal, a denial or the deadline', async () => {
    fake(json({ status: 'denied' }));
    await expect(pollDevice(cn, device())).rejects.toThrow(/turned down/);
    fake(json({ status: 'expired_token' }));
    await expect(pollDevice(cn, device())).rejects.toThrow(/expired/);
    fake(json({ error: 'access_denied' }, 400));
    await expect(pollDevice(cn, device())).rejects.toThrow(/access_denied/);
    await expect(pollDevice(cn, device({ deadline: Date.now() - 1 }))).rejects.toThrow(/expired/);
  });

  it('names the account', () => {
    const t = { access: 'A', refresh: 'R', expires: 5, accountID: 'acc', subject: 'sub' };
    expect(signedInResult(cn, t, { realUserID: '9', email: 'e@x', name: 'N' })).toEqual({
      key: '9', displayName: 'e@x', email: 'e@x', credential: { access: 'A', refresh: 'R', expires: 5, realUserID: '9', email: 'e@x', name: 'N' },
    });
    expect(signedInResult(cn, t, {})).toEqual({ key: 'acc', displayName: 'acc', email: null, credential: { access: 'A', refresh: 'R', expires: 5 } });
    expect(signedInResult(cn, { access: 'A', refresh: '', expires: 5 }, {})).toMatchObject({ key: 'minimax-code', displayName: 'MiniMax Code' });
  });

  it('reads a token answer, keeping the old refresh token when none is sent', () => {
    const t = token({ access_token: jwtOf({ sub: 's', account_id: 'acc' }), expires_in: 60 }, 'OLD');
    expect(t).toMatchObject({ refresh: 'OLD', subject: 's', accountID: 'acc' });
    expect(t.expires).toBeGreaterThan(Date.now() + 59000);
    expect(token({ access_token: 'x', refresh_token: 'NEW', expires_in: 1 }, 'OLD').refresh).toBe('NEW');
    expect(() => token({ access_token: 'x' })).toThrow(/invalid_token_response/);
  });

  describe('the flow', () => {
    const opts = (fetch) => ({ permissions: PERMS, params: { provider: 'minimax-code-global' }, fetch });
    const start = (url) =>
      url.endsWith('/device/code')
        ? json({ user_code: 'U-1', verification_url: 'https://v', expired_in: Date.now() + 60000, interval: 1 })
        : null;

    it('shows the code, waits, and adds the account on the site it was opened for', async () => {
      let polls = 0;
      const view = await mount(signIn, opts(async ({ url }) => {
        if (start(url)) return start(url);
        if (url.endsWith('/oauth2/token')) return ++polls < 2 ? json({ status: 'pending' }) : json({ access_token: 'A', refresh_token: 'R', expires_in: 3600 });
        if (url.includes('/v1/api/user/info')) return json({ statusInfo: { code: 0 }, data: { userInfo: { realUserID: '77', email: 'me@x' } } });
        return raw('', 404);
      }));
      expect(view.find('Button').props.label).toBe('signIn.start');
      expect(view.find('Heading').props.value).toBe('signIn.title');
      const effects = await view.press('start');
      expect(effects.some((e) => e.type === 'openExternal')).toBe(true);
      expect(effects.some((e) => e.type === 'close')).toBe(true);
      expect(host().flushed[0].device.userCode).toBe('U-1');
      const account = host().accounts.get('minimax-code-global').get('77');
      expect(account).toMatchObject({ displayName: 'me@x', email: 'me@x', status: 'active' });
      expect(JSON.parse(account.secret)).toMatchObject({ access: 'A', refresh: 'R', realUserID: '77' });
      expect(host().accounts.has('minimax-code')).toBe(false);
    });

    it('keeps the code on screen when a slice ends unconfirmed, and shows a refusal', async () => {
      let answer = json({ status: 'pending' });
      const view = await mount(signIn, opts(async ({ url }) => (start(url) ? { ...start(url), body: { ...start(url).body, interval: 50000 } } : answer)));
      await view.press('start');
      expect(view.state.device.userCode).toBe('U-1');
      expect(view.find('Button').props.label).toBe('signIn.continue');
      expect(view.state.error).toBeNull();
      view.state.device.intervalMs = 1;
      answer = json({ status: 'denied' });
      await view.press('wait');
      expect(view.state.device).toBeNull();
      expect(view.find('Alert').props.message).toMatch(/turned down/);
      expect(host().accounts.size).toBe(0);
    });

    it('shows a failed start', async () => {
      const view = await mount(signIn, opts(async () => json({ error: 'invalid_client' }, 400)));
      await view.press('start');
      expect(view.find('Alert').props.message).toMatch(/invalid_client/);
    });
  });
});

describe('refreshing', () => {
  const save = async () => true;

  it('uses a token far from its end as is', async () => {
    const calls = fake();
    const r = await freshOf(cn, save)(async () => stored());
    expect(r.a.access).toBe('A0');
    expect(r.renewed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refreshes a token near its end once and saves it', async () => {
    const calls = fake(tokenAnswer('A1', 'R1'));
    const saved = [];
    const fresh = freshOf(cn, async (a) => (saved.push(a), true));
    const auth = stored({ refresh: 'R-near', expires: Date.now() + 60e3 });
    const [x, y] = await Promise.all([fresh(async () => auth), fresh(async () => auth)]);
    expect(calls).toHaveLength(1);
    expect([x.a.access, y.a.access, x.renewed]).toEqual(['A1', 'A1', true]);
    expect(saved).toHaveLength(1);
    expect(saved[0].refresh).toBe('R1');
    expect(form(calls[0].body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'R-near' });
    // a later request reading the old token joins the refresh rather than spending it again
    expect((await fresh(async () => auth)).a.access).toBe('A1');
    expect(calls).toHaveLength(1);
  });

  it('follows renewals, and lets go a saved one after a minute', async () => {
    fake(tokenAnswer('A1', 'R1'));
    const a = stored({ refresh: 'R-chain', expires: 0 });
    await renew(cn, a, save);
    expect(latest(cn, a).access).toBe('A1');
    const done = renewed.get(cn.id + '\nR-chain');
    done.at = Date.now() - 61000;
    expect(latest(cn, a).access).toBe('A0');
    done.saved = false;
    expect(latest(cn, a).access).toBe('A1');
  });

  it('refreshes a rejected token unless a newer one is had', async () => {
    const fresh = freshOf(cn, save);
    const r = await fresh(async () => stored({ access: 'NEW' }), 'OLD');
    expect([r.a.access, r.renewed]).toEqual(['NEW', true]);
    fake(tokenAnswer('A9', 'R9'));
    const f = await fresh(async () => stored({ refresh: 'R-rej' }), 'A0');
    expect([f.a.access, f.renewed]).toEqual(['A9', true]);
  });

  it('signs out on invalid_grant (400); another failure keeps the token in hand', async () => {
    const near = stored({ refresh: 'R-bad', expires: Date.now() + 60e3 });
    const fresh = freshOf(cn, save);
    fake(json({ error: 'invalid_grant' }, 400));
    await expect(fresh(async () => near)).rejects.toSatisfy((e) => e instanceof SignInExpired && e.signIn === 'expired');
    renewed.clear();
    fake(json({ error: 'server_error' }, 500));
    expect((await fresh(async () => ({ ...near, refresh: 'R-bad2' }))).a.access).toBe('A0');
    renewed.clear();
    fake(json({ error: 'server_error' }, 500));
    await expect(fresh(async () => ({ ...near, refresh: 'R-bad3', expires: Date.now() - 1 }))).rejects.toSatisfy((e) => e.signIn === 'kept' && /token refresh/.test(e.message));
  });

  it('is not a sign-out when the refresh token was spent elsewhere and the new one is stored', async () => {
    fake(json({ error: 'invalid_grant' }, 400));
    let reads = 0;
    const getAuth = async () => (++reads === 1 ? stored({ refresh: 'R-old', expires: Date.now() + 60e3 }) : stored({ access: 'ELSEWHERE', refresh: 'R-else' }));
    expect((await freshOf(cn, save)(getAuth)).a.access).toBe('ELSEWHERE');
  });

  it('expires an account with no refresh token with its access token', async () => {
    const fresh = freshOf(cn, save);
    expect((await fresh(async () => stored({ refresh: '', expires: Date.now() + 60e3 }))).a.access).toBe('A0');
    await expect(fresh(async () => stored({ refresh: '', expires: Date.now() - 1 }))).rejects.toBeInstanceOf(SignInExpired);
    await expect(fresh(async () => undefined)).rejects.toThrow(/isn't signed in/);
  });
});

describe('provider.prepare', () => {
  const req = (extra = {}) => ({ protocol: 'anthropic', model: 'MiniMax-M3', path: '/v1/messages', method: 'POST', headers: {}, body: { model: 'MiniMax-M3', stream: false }, stream: false, ...extra });
  const prepare = (r, secret, fetch = async () => raw('', 500), provider = 'minimax-code') =>
    runProvider(plugin, provider, 'prepare', r, secret === null ? null : { key: '42', secret: JSON.stringify(secret ?? stored()) }, { permissions: PERMS, fetch });

  it("sends MiniMax Code's headers to the site's messages endpoint", async () => {
    const p = await prepare(req({ headers: { 'anthropic-version': 'x' } }));
    expect(p.url).toBe('https://agent.minimax.cn/mavis/api/v1/llm/v1/messages');
    expect(p.headers).toMatchObject({ authorization: 'Bearer A0', 'x-api-key': 'sk-xxx', 'user-agent': 'MiniMaxAgent', 'x-mavis-agent-id': 'main', 'anthropic-version': 'x' });
    expect(p.headers['x-mavis-timezone-offset']).toMatch(/^-?\d+$/);
    expect(p.headers['x-mavis-session-id']).toBeTruthy();
    expect(p.body).toEqual({ model: 'MiniMax-M3', stream: true }); // always streamed; the reply collapses it
    expect((await prepare(req(), undefined, undefined, 'minimax-code-global')).url).toBe('https://agent.minimax.io/mavis/api/v1/llm/v1/messages');
  });

  it("keeps the client's session id and defaults anthropic-version", async () => {
    const p = await prepare(req({ headers: { 'x-mavis-session-id': 'mine' } }));
    expect(p.headers['x-mavis-session-id']).toBe('mine');
    expect(p.headers['anthropic-version']).toBe('2023-06-01');
    const a = await prepare(req());
    const b = await prepare(req());
    expect(a.headers['x-mavis-session-id']).toBe(b.headers['x-mavis-session-id']);
  });

  it('refuses another protocol, and a missing account', async () => {
    await expect(prepare(req({ protocol: 'chat' }))).rejects.toThrow(/Anthropic messages/);
    await expect(prepare(req(), null)).rejects.toThrow(/isn't signed in/);
  });

  it('refreshes a token near its end and saves the new credential on the account', async () => {
    const calls = [];
    const p = await prepare(req(), stored({ refresh: 'R-prep', expires: Date.now() + 60e3 }), async (r) => (calls.push(r), tokenAnswer('A7', 'R7')));
    expect(p.headers.authorization).toBe('Bearer A7');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(host().accounts.get('minimax-code').get('42').secret)).toMatchObject({ access: 'A7', refresh: 'R7' });
  });

  it('fails the request and marks the account when MiniMax signed it out', async () => {
    await expect(prepare(req(), stored({ refresh: 'R-gone', expires: Date.now() + 60e3 }), async () => json({ error: 'invalid_grant' }, 400))).rejects.toThrow(/signed out/);
    expect(host().accounts.get('minimax-code').get('42').status).toBe('expired');
  });
});

describe('provider.refresh', () => {
  const refresh = (secret, fetch) => runProvider(plugin, 'minimax-code', 'refresh', null, { key: '42', secret: JSON.stringify(secret) }, { permissions: PERMS, fetch });

  it('refreshes the token MiniMax turned away', async () => {
    expect(await refresh(stored({ refresh: 'R-401' }), async () => tokenAnswer('A5', 'R5'))).toBe('renewed');
    expect(JSON.parse(host().accounts.get('minimax-code').get('42').secret)).toMatchObject({ access: 'A5', refresh: 'R5' });
  });

  it('says expired for a signed-out account, and nothing for a passing failure', async () => {
    expect(await refresh(stored({ refresh: '' }), async () => raw('', 500))).toBe('expired');
    expect(await refresh(stored({ refresh: 'R-out' }), async () => json({ error: 'invalid_grant' }, 400))).toBe('expired');
    expect(await refresh(stored({ refresh: 'R-pass' }), async () => json({ error: 'server_error' }, 500))).toBeNull();
  });
});

// ---- the reply: out-of-credits refusals as 429, and the stream collapsed for a client that wanted one message
describe('reply', () => {
  const reply = (frames, o = {}) => runResponse(plugin, 'minimax-code', { frames, request: { protocol: 'anthropic', model: 'MiniMax-M3', stream: true, ...o.request }, response: o.response });
  const ev = (e) => ({ event: e.type, data: JSON.stringify(e), json: e });
  const stream = [
    { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'MiniMax-M3', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ].map(ev);

  it('turns an out-of-credits 402 or 403 into a 429 so another account can take over', async () => {
    const quota = await reply([], { response: { status: 402, body: JSON.stringify({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }) } });
    expect(quota.error).toEqual({ status: 429, message: 'usage limit reached: insufficient balance' });
    const plan = await reply([], { response: { status: 403, body: '{"error":{"message":"M Plan 额度已用完"}}' } });
    expect(plan.error).toMatchObject({ status: 429, message: 'usage limit reached: M Plan 额度已用完' });
  });

  it('leaves other refusals as they are: a non-quota 403, a 429, a 500', async () => {
    for (const [status, body] of [[403, '{"error":{"message":"forbidden region"}}'], [429, '{"error":{"message":"rate limit"}}'], [500, 'quota backend down']]) {
      const out = await reply([], { response: { status, body } });
      expect(out.error).toBeNull();
      expect(out.status).toBe(status);
    }
    expect(QUOTA.test('forbidden region')).toBe(false);
  });

  it('streams the events on as anthropic event pairs, dropping non-JSON keep-alives', async () => {
    const out = await reply([...stream.slice(0, 3), { data: ': ping' }, ...stream.slice(3)]);
    expect(out.failure).toBeNull();
    expect(out.frames.map((f) => f.event)).toEqual(stream.map((f) => f.event));
    expect(out.frames[6].data.delta.text).toBe('Hel');
  });

  it('collapses the stream into one message for a client that wanted JSON', async () => {
    const out = await reply(stream, { request: { stream: false } });
    expect(out.failure).toBeNull();
    expect(out.body).toMatchObject({ id: 'm1', type: 'message', role: 'assistant', stop_reason: 'end_turn', usage: { output_tokens: 5 } });
    expect(out.body.content).toEqual([{ type: 'thinking', thinking: 'hm', signature: 'sig' }, { type: 'text', text: 'Hello' }]);
  });

  it('collapses a tool call, parsing its input', async () => {
    const out = await reply([
      { type: 'message_start', message: { id: 'm2', role: 'assistant', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"p":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ].map(ev), { request: { stream: false } });
    expect(out.body.content[0].input).toEqual({ p: 'a' });
  });

  it('fails a stream that ends without message_stop, and an in-stream error of a one-body reply', async () => {
    expect((await reply(stream.slice(0, 4))).failure).toEqual({ status: 502, message: 'Upstream SSE ended without a completion marker' });
    const err = await reply([{ event: 'error', data: '{}', json: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } }], { request: { stream: false } });
    expect(err.failure).toEqual({ status: 502, message: 'busy' });
    const live = await reply([{ event: 'error', data: '{}', json: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } }]);
    expect(live.frames[0]).toEqual({ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } });
  });

  it('the transform is registered on both sites', () => {
    expect(transformResponse.frame).toBeTypeOf('function');
  });
});
