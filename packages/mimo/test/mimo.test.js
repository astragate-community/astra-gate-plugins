import { beforeEach, describe, expect, it } from 'vitest';
import { mount, runProvider } from '@astragate/plugin-sdk/testing';
import plugin, { parseSecret, signIn } from '../src/main.js';
import { REGIONS } from '../src/constants.js';
import { planModel, planUrl, renamedBody } from '../src/request.js';
import { Jar, cookieHeader } from '../src/cookies.js';
import { resetPlatform, credits, creditWindow } from '../src/platform.js';
import { planOf, serverTime, weekOf } from '../src/usage.js';
import { secretOf } from '../src/session.js';

const XIAOMI = ['https://account.xiaomi.com', 'https://mimo-server-sgp.xiaomimimo.com', 'https://mimo-server-ru.xiaomimimo.com', 'https://mimo-server-in.xiaomimimo.com', 'https://platform.xiaomimimo.com'];
const PERMS = ['providers', 'ui', ...Object.values(REGIONS).map((b) => 'net:' + new URL(b).origin), ...XIAOMI.map((o) => 'net:' + o)];
const KEY = 'tp-abcdefghijklmnop';
const secret = (o = {}) => JSON.stringify({ key: KEY, base: REGIONS.cn, ...o });
const host = () => globalThis.__astraTestHost;

describe('model names', () => {
  it("asks the Token Plan's names; mimo-auto is mimo-pro; others pass as they are", () => {
    expect(planModel('mimo-pro')).toBe('mimo-v2.6-pro');
    expect(planModel('mimo-flash')).toBe('mimo-v2.6-flash');
    expect(planModel('mimo-auto')).toBe('mimo-v2.6-pro');
    expect(planModel('mimo-v2.6-pro')).toBe('mimo-v2.6-pro');
    expect(planModel('other')).toBe('other');
    expect(planModel('__proto__')).toBe('__proto__');
  });

  it('renames the body without touching the original', () => {
    const body = { model: 'mimo-pro', messages: [] };
    expect(renamedBody(body)).toEqual({ model: 'mimo-v2.6-pro', messages: [] });
    expect(body.model).toBe('mimo-pro');
    const plain = { model: 'x' };
    expect(renamedBody(plain)).toBe(plain);
    expect(renamedBody(null)).toBeNull();
    expect(renamedBody({ messages: [] })).toEqual({ messages: [] });
  });

  it("puts the gateway's path under the plan's base", () => {
    expect(planUrl(REGIONS.cn, '/v1/chat/completions')).toBe('https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
    expect(planUrl('https://token-plan-cn.xiaomimimo.com/v1/', '/chat/completions?x=1')).toBe('https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
    expect(planUrl(REGIONS.cn, undefined)).toBe('https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
  });
});

describe('credential', () => {
  it('is a tp- key with one of the known endpoints', () => {
    expect(parseSecret(secret())).toEqual({ key: KEY, base: REGIONS.cn });
    expect(parseSecret(secret({ key: 'sk-x' }))).toBeNull();
    expect(parseSecret(secret({ base: 'https://evil.example/v1' }))).toBeNull();
    expect(parseSecret('nope')).toBeNull();
    expect(parseSecret('null')).toBeNull();
  });
});

describe('provider', () => {
  const req = (extra = {}) => ({ protocol: 'chat', model: 'mimo-pro', path: '/v1/chat/completions', method: 'POST', headers: {}, body: { model: 'mimo-pro', stream: true }, stream: true, ...extra });
  const run = (what, request, s = secret()) => runProvider(plugin, 'mimo-app', what, request, s === null ? null : { key: 'k', secret: s }, { permissions: PERMS });

  it("sends the request to the plan's endpoint with the key and the plan's model name", async () => {
    const p = await run('prepare', req());
    expect(p.url).toBe('https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
    expect(p.headers).toEqual({ authorization: 'Bearer ' + KEY });
    expect(p.body).toEqual({ model: 'mimo-v2.6-pro', stream: true });
  });

  it("goes to the account's region", async () => {
    expect((await run('prepare', req(), secret({ base: REGIONS.sgp }))).url).toBe('https://token-plan-sgp.xiaomimimo.com/v1/chat/completions');
  });

  it('sends a body that needs no renaming as it is', async () => {
    const p = await run('prepare', req({ body: { model: 'mimo-v2.6-flash' } }));
    expect(p.body).toBeUndefined();
  });

  it('refuses other protocols, and an account without a usable key', async () => {
    await expect(run('prepare', req({ protocol: 'anthropic' }))).rejects.toThrow(/Chat Completions/);
    await expect(run('prepare', req(), null)).rejects.toThrow(/Token Plan key/);
    await expect(run('prepare', req(), secret({ key: 'nope' }))).rejects.toThrow(/Token Plan key/);
  });

  it('marks an account expired after a 401/403: the key does not renew', async () => {
    expect(await run('refresh', null)).toBe('expired');
  });
});

describe('sign-in flow', () => {
  const open = () => mount(signIn, { permissions: PERMS });
  const save = (view, values) => view.press('save', { values });

  it('adds an account with the key and the chosen region, and closes', async () => {
    const view = await open();
    expect(view.find('Form')).toBeTruthy();
    expect(view.find('PasswordField').props.name).toBe('key');
    const effects = await save(view, { key: ` ${KEY} `, region: 'sgp' });
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const [account] = [...host().accounts.get('mimo-app').values()];
    expect(account).toMatchObject({ displayName: 'Token Plan …mnop', plan: 'Token Plan', status: 'active' });
    expect(JSON.parse(account.secret)).toEqual({ key: KEY, base: REGIONS.sgp });
    expect(account.key).not.toContain(KEY.slice(-8));
  });

  it('keeps one account per key', async () => {
    const view = await open();
    await save(view, { key: KEY, region: 'cn' });
    await save(view, { key: KEY, region: 'cn' });
    expect(host().accounts.get('mimo-app').size).toBe(1);
  });

  it('refuses a key that is not a Token Plan key, and an unknown region', async () => {
    const view = await open();
    expect((await save(view, { key: 'sk-123456789012', region: 'cn' })).some((e) => e.type === 'fail')).toBe(true);
    expect((await save(view, { key: KEY, region: 'moon' })).some((e) => e.type === 'fail')).toBe(true);
    expect(host().accounts.size).toBe(0);
  });
});

// ---- the Xiaomi-account sign-on: redirects walked by hand with a cookie jar
const BASE = 'https://mimo-server-sgp.xiaomimimo.com/api';
const PLATFORM = 'https://platform.xiaomimimo.com';
const creds = (o = {}) => ({ userId: '42', cUserId: 'cu', passToken: 'PT', deviceId: 'pc_dev', region: 'SGP', base: BASE, ...o });
const xsecret = (o = {}, cookies = { serviceToken: 'ST0', userId: '42' }, expires = Date.now() + 3600e3) => JSON.stringify({ kind: 'xiaomi', creds: creds(o), cookies, expires });
const redirect = (to, setCookies = []) => ({ status: 302, headers: { location: to }, setCookies, body: '' });
const jsonReply = (v, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });
const has = (req, cookie) => (req.headers?.cookie ?? '').split('; ').includes(cookie);

/** A fake Xiaomi / MiMo world: one fetch that answers each hop of the sign-on like the real servers, and records the calls. */
function world({ lapsed = false, plan = true, appPlan = null, week = { percent: 40, resetDate: '2026-11-20' }, calls = [] } = {}) {
  const fetch = async (req) => {
    calls.push(req);
    const u = new URL(req.url);
    const at = u.origin + u.pathname;
    if (u.origin === 'https://mimo-server-sgp.xiaomimimo.com') {
      if (u.pathname === '/api/user/xiaomi/me') {
        if (!has(req, 'serviceToken=ST1')) return redirect(`https://account.xiaomi.com/pass/serviceLogin?sid=mimosgp&callback=${encodeURIComponent(BASE + '/sts')}&_json=true`);
        return jsonReply({ code: 0, data: { userId: '42', region: 'SGP' } });
      }
      if (u.pathname === '/api/sts') return redirect('/api/user/xiaomi/me', ['serviceToken=ST1; Path=/; Domain=.xiaomimimo.com; Secure', 'userId=42; Path=/']);
      if (u.pathname === '/api/user/xiaomi/subscription/self') return has(req, 'serviceToken=ST1') ? jsonReply({ code: 0, data: { current: appPlan } }) : redirect('https://account.xiaomi.com/pass/serviceLogin?sid=mimosgp');
      if (u.pathname === '/api/user/usage') return has(req, 'serviceToken=ST1') ? jsonReply({ code: 0, data: week }) : redirect('https://account.xiaomi.com/pass/serviceLogin?sid=mimosgp');
    }
    if (at === 'https://account.xiaomi.com/pass/serviceLogin') {
      if (lapsed || !has(req, 'passToken=PT')) return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>sign in</html>' };
      const sid = u.searchParams.get('sid');
      return redirect(sid === 'api-platform' ? PLATFORM + '/sts?t=1' : 'http://mimo-server-sgp.xiaomimimo.com/api/sts?d=1');
    }
    if (u.origin === PLATFORM) {
      if (u.pathname === '/sts') return redirect('/api/v1/tokenPlan/detail', ['platformToken=PL1; Path=/; Secure']);
      if (u.pathname.startsWith('/api/v1/')) {
        if (!has(req, 'platformToken=PL1')) return jsonReply({ loginUrl: 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform' }, 401);
        if (u.pathname === '/api/v1/tokenPlan/detail') return jsonReply({ code: 0, data: plan ? { planName: 'Pro', expired: false, enableAutoRenew: true, currentPeriodEnd: '2026-11-06 23:59:59' } : {} });
        if (u.pathname === '/api/v1/tokenPlan/apiKey') return jsonReply({ code: 0, data: { openaiBaseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1' } });
        if (u.pathname === '/api/v1/tokenPlan/apiKey/raw') return jsonReply({ code: 0, data: 'tp-from-platform-1234' });
        if (u.pathname === '/api/v1/tokenPlan/usage') return jsonReply({ code: 0, data: { monthUsage: { items: [{ name: 'month_total_token', used: 6810000, limit: 10000000 }] } } });
      }
    }
    return { status: 404, headers: {}, body: '' };
  };
  return { fetch, calls };
}

describe('cookie jar', () => {
  it('keeps what a reply sets, by domain and path, and sends it back', () => {
    const jar = new Jar();
    jar.take(['a=1; Path=/; Domain=.xiaomimimo.com; Secure', 'b=2', 'gone=x; Max-Age=0'], 'https://mimo-server-sgp.xiaomimimo.com/api/sts');
    expect(jar.header('https://mimo-server-sgp.xiaomimimo.com/api/user')).toBe('a=1; b=2');
    expect(jar.header('https://platform.xiaomimimo.com/')).toBe('a=1'); // a domain cookie; b was host-only
    expect(jar.header('http://mimo-server-sgp.xiaomimimo.com/api/user')).toBe('b=2'); // a secure one stays on https
    expect(jar.header('https://account.xiaomi.com/')).toBe('');
    expect(cookieHeader({ x: '1', userId: '9', serviceToken: 't' })).toBe('serviceToken=t; userId=9; x=1');
  });
});

describe('Xiaomi account: requests', () => {
  beforeEach(resetPlatform);
  const req = (extra = {}) => ({ protocol: 'chat', model: 'mimo-auto', path: '/v1/chat/completions', method: 'POST', headers: {}, body: { model: 'mimo-auto', stream: true }, stream: true, ...extra });
  const acct = (s = xsecret()) => ({ key: 'xiaomi-42', secret: s });
  const run = (what, request, account, w = world()) => runProvider(plugin, 'mimo-app', what, request, account, { permissions: PERMS, fetch: w.fetch });

  it("sends the request to the app's /route with the session's cookies, mimo-auto as mimo-pro", async () => {
    const w = world();
    const p = await run('prepare', req(), acct(), w);
    expect(p.url).toBe(BASE + '/route/chat/completions');
    expect(p.headers).toMatchObject({ cookie: 'serviceToken=ST0; userId=42', 'x-mimo-source': 'mimocode-cli-free', 'x-client-version': expect.any(String) });
    expect(p.headers['user-agent']).toMatch(/miNative PC/);
    expect(p.headers.authorization).toBeUndefined();
    expect(p.body).toEqual({ model: 'mimo-pro', stream: true });
    expect(w.calls).toHaveLength(0);
  });

  it('signs on again when the session is older than a day, keeping the new one', async () => {
    const w = world();
    const p = await run('prepare', req({ body: { model: 'mimo-flash' } }), acct(xsecret({}, { serviceToken: 'old' }, Date.now() - 1)), w);
    expect(p.headers.cookie).toBe('serviceToken=ST1; userId=42');
    // me (no session) -> serviceLogin with the passToken -> sts over https -> me again, every hop with the jar's cookie
    expect(w.calls.map((c) => c.redirect)).toEqual(['manual', 'manual', 'manual', 'manual']);
    expect(w.calls[1].headers.cookie).toContain('passToken=PT');
    expect(w.calls[2].url).toBe('https://mimo-server-sgp.xiaomimimo.com/api/sts?d=1');
    const saved = JSON.parse(host().accounts.get('mimo-app').get('xiaomi-42').secret);
    expect(saved.cookies).toMatchObject({ serviceToken: 'ST1' });
    expect(saved.creds.passToken).toBe('PT');
    expect(saved.expires).toBeGreaterThan(Date.now() + 23 * 3600e3);
    expect(p.body).toBeUndefined();
  });

  it('marks an account expired when Xiaomi no longer signs it on', async () => {
    const w = world({ lapsed: true });
    await expect(run('prepare', req(), acct(xsecret({}, {}, 0)), w)).rejects.toThrow(/lapsed/);
    expect(host().accounts.get('mimo-app').get('xiaomi-42').status).toBe('expired');
  });

  it("goes on with the session in hand when signing on again fails for another reason", async () => {
    const p = await run('prepare', req(), acct(xsecret({}, { serviceToken: 'ST0' }, Date.now() - 1)), { fetch: async () => ({ status: 503, headers: {}, body: '' }) });
    expect(p.headers.cookie).toBe('serviceToken=ST0');
  });

  it("falls back to the account's Token Plan after the app's membership_required, as v1 did", async () => {
    const w = world();
    const failed = { status: 403, body: JSON.stringify({ error: { code: 'membership_required', message: 'no membership' } }) };
    expect(await run('refresh', failed, acct(), w)).toBe('renewed');
    const p = await run('prepare', req(), acct(), w);
    expect(p.url).toBe('https://token-plan-sgp.xiaomimimo.com/v1/chat/completions');
    expect(p.headers).toEqual({ authorization: 'Bearer tp-from-platform-1234' });
    expect(p.body).toEqual({ model: 'mimo-v2.6-pro', stream: true });
    // the platform was signed on with the passToken: serviceLogin (sid api-platform) -> /sts -> the page
    expect(w.calls.some((c) => c.url.startsWith(PLATFORM + '/sts'))).toBe(true);
    // a key the plan turned away is read again
    expect(await run('refresh', { status: 401, body: '' }, acct(), w)).toBe('renewed');
    expect(w.calls.filter((c) => c.url.endsWith('/apiKey/raw')).length).toBe(1);
    await run('prepare', req(), acct(), w);
    expect(w.calls.filter((c) => c.url.endsWith('/apiKey/raw')).length).toBe(2);
  });

  it('leaves the refusal alone when there is no Token Plan to fall back to', async () => {
    const w = world({ plan: false });
    expect(await run('refresh', { status: 403, body: JSON.stringify({ error: { code: 'membership_required' } }) }, acct(), w)).toBeNull();
    expect((await run('prepare', req(), acct(), w)).url).toBe(BASE + '/route/chat/completions');
  });

  it('signs on again after another 401, and says expired for a lapsed passToken', async () => {
    const w = world();
    expect(await run('refresh', { status: 401, body: '' }, acct(), w)).toBe('renewed');
    expect(JSON.parse(host().accounts.get('mimo-app').get('xiaomi-42').secret).cookies.serviceToken).toBe('ST1');
    expect(await run('refresh', { status: 401, body: '' }, acct(), world({ lapsed: true }))).toBe('expired');
  });
});

describe('Xiaomi account: the allowance card', () => {
  beforeEach(resetPlatform);
  const card = (w) => runProvider(plugin, 'mimo-app', 'usage', null, { key: 'xiaomi-42', secret: xsecret() }, { permissions: PERMS, fetch: w.fetch });

  it("reads the week's allowance and, with no app plan, the platform's Token Plan as the plan", async () => {
    const out = await card(world({ appPlan: null }));
    expect(out).toMatchObject({ plan: 'Token Plan Pro', renew: 'auto', until: '2026-11-06T23:59:59.000Z' });
    expect(out.windows).toEqual([
      { name: '7 days', used: 60, span: 604800, resetsAt: '2026-11-19T16:00:00.000Z' },
      { name: 'Token Plan', used: 68.1, display: '6.81M / 10M credits', resetsAt: '2026-11-06T23:59:59.000Z' },
    ]);
  });

  it('shows the app plan, with the Token Plan beside it as an aside', async () => {
    const out = await card(world({ appPlan: { title: 'Plus', endTime: '2026-12-01T00:00:00', renewalMode: 'MONTHLY' } }));
    expect(out).toMatchObject({ plan: 'Plus', renew: 'auto', until: '2026-11-30T16:00:00.000Z' });
    expect(out.windows[1]).toMatchObject({ name: 'Token Plan · API key', aside: true });
  });

  it('says the plan is Free with no plan at all, and words a lapsed sign-in', async () => {
    expect(await card(world({ plan: false, week: {} }))).toEqual({ plan: 'Free' });
    const lapsed = await runProvider(plugin, 'mimo-app', 'usage', null, { key: 'xiaomi-42', secret: xsecret({}, {}, 0) }, { permissions: PERMS, fetch: world({ lapsed: true }).fetch });
    expect(lapsed).toMatchObject({ signIn: 'expired', error: expect.stringContaining('lapsed') });
  });

  it('formats the pieces', () => {
    expect(credits(6810000)).toBe('6.81M');
    expect(credits(4.1e9)).toBe('4.1B');
    expect(credits(12)).toBe('12');
    expect(serverTime('2026-10-01T00:00:00')).toBe('2026-09-30T16:00:00.000Z');
    expect(serverTime('2026-10-01')).toBe('2026-09-30T16:00:00.000Z');
    expect(serverTime('nope')).toBeUndefined();
    expect(weekOf({ percent: 100, resetDate: '2026-10-01' })).toMatchObject({ used: 0 });
    expect(weekOf({})).toBeNull();
    expect(planOf({ planTier: 3, renewalMode: 'ONE_TIME' })).toEqual({ plan: 'Pro', renew: 'off' });
    expect(creditWindow({}, false)).toBeNull();
  });
});

describe('Xiaomi account: sign-in flow', () => {
  beforeEach(resetPlatform);
  const LP = 'https://account.xiaomi.com/longPolling/poll?t=1';
  const guard = (v) => '&&&START&&&' + JSON.stringify(v);
  function flow({ polls = [] } = {}) {
    const w = world();
    const calls = w.calls;
    const fetch = async (req) => {
      const u = new URL(req.url);
      if (u.origin + u.pathname === 'https://account.xiaomi.com/longPolling/loginUrl') {
        calls.push(req);
        return { status: 200, headers: {}, body: guard({ code: 0, loginUrl: 'https://account.xiaomi.com/qr/abc', lp: LP, timeout: 300 }) };
      }
      if (req.url === LP) {
        calls.push(req);
        return polls.shift() ?? { status: 200, headers: {}, body: guard({ code: 1 }) };
      }
      return w.fetch(req);
    };
    return { fetch, calls };
  }
  const open = (f) => mount(signIn, { permissions: PERMS, fetch: f.fetch });

  it('opens Xiaomi\'s sign-in page, waits for the account, and adds it with its session', async () => {
    const f = flow({ polls: [{ status: 200, headers: {}, body: guard({ code: 0, userId: 42, cUserId: 'cu', passToken: 'PT' }) }] });
    const view = await open(f);
    const effects = await view.press('start');
    expect(effects.some((e) => e.type === 'openExternal' && e.url === 'https://account.xiaomi.com/qr/abc')).toBe(true);
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const login = f.calls.find((c) => c.url.includes('/loginUrl'));
    expect(new URL(login.url).searchParams.get('sid')).toBe('mimosgp');
    expect(login.headers.cookie).toMatch(/^deviceId=pc_[0-9a-f]{32}; pass_ua=pc/);
    const account = host().accounts.get('mimo-app').get('xiaomi-42');
    expect(account.displayName).toBe('Xiaomi 42');
    const secret = JSON.parse(account.secret);
    expect(secret).toMatchObject({ kind: 'xiaomi', creds: { userId: '42', passToken: 'PT', region: 'SGP', base: BASE }, cookies: { serviceToken: 'ST1' } });
    expect(secret.creds.deviceId).toMatch(/^pc_/);
  });

  it('says so when Xiaomi signs the account in but the MiMo server does not take it', async () => {
    const f = flow({ polls: [{ status: 200, headers: {}, body: guard({ code: 0, userId: 42, passToken: 'BAD' }) }] });
    const view = await open(f);
    await view.press('start');
    expect(host().accounts.get('mimo-app')?.size ?? 0).toBe(0);
  });
});
