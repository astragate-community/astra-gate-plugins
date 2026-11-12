import { describe, expect, it } from 'vitest';
import { mount } from '@astragate/plugin-sdk/testing';
import { signIn } from '../src/main.js';
import { PERMS, balance, jwtExpiring, ok, routed } from './support.js';

const accounts = () => globalThis.__astraTestHost.accounts.get('zcode');
const client = { locale: 'zh-CN', timeZone: 'Asia/Shanghai', utcOffset: 480 };
const open = (fetch) => mount(signIn, { permissions: PERMS, fetch, client });

describe('sign-in flow', () => {
  it('offers the two sites and a pasted key', async () => {
    const view = await open();
    expect(view.findAll('Button').map((b) => b.props.label)).toEqual(['signIn.zai', 'signIn.bigmodel', 'signIn.key']);
  });

  it('a pasted key is added under a name of its own, with its plan', async () => {
    const { fetch } = routed([['/subscription/list', ok([{ status: 'VALID', productName: 'GLM Coding Pro' }])]]);
    const view = await open(fetch);
    await view.press('key');
    await view.change('site', 'bigmodel');
    await view.change('key', ' id.secret ');
    const effects = await view.press('submitKey');
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    const [[name, account]] = [...accounts()];
    expect(name).toMatch(/^key-[0-9a-f]{10}$/);
    expect(JSON.parse(account.secret)).toMatchObject({ site: 'bigmodel', key: 'id.secret', plan: 'GLM Coding Pro' });
    expect(account.plan).toBe('GLM Coding Pro');
  });

  it('an empty key is refused in the field', async () => {
    const view = await open();
    await view.press('key');
    const effects = await view.press('submitKey');
    expect(effects.some((e) => e.type === 'fail' || e.errors)).toBe(true);
    expect(accounts()?.size ?? 0).toBe(0);
  });

  it("the browser flow polls until ZCode says it is ready, then keeps the account's key", async () => {
    let polls = 0;
    const { fetch, calls } = routed([
      ['/oauth/cli/init', ok({ flow_id: 'f1', authorize_url: 'https://z.ai/authorize?x=1', poll_interval_sec: 0 })],
      ['/oauth/cli/poll/f1', () => ok(++polls < 2 ? { status: 'pending' } : { status: 'ready', token: jwtExpiring(3600), zai: { access_token: 'zt' }, user: { email: 'me@x.io' } })],
      ['/api/auth/z/login', ok({ access_token: 'biz' })],
      ['/getCustomerInfo', ok({ organizations: [{ organizationId: 'o1', organizationName: '默认机构', projects: [{ projectId: 'p1', projectName: '默认项目', projectType: 1 }] }] })],
      ['/api_keys/copy/', ok({ secretKey: 'sec' })],
      ['/api_keys', (r) => (r.method === 'POST' ? ok({ apiKey: 'id1' }) : ok([]))],
      ['/subscription/list', ok([{ status: 'VALID', productName: 'GLM Coding Lite' }])],
    ]);
    const view = await open(fetch);
    const effects = await view.press('browser', { site: 'zai' });
    expect(effects.some((e) => e.type === 'openExternal' || e.url)).toBe(true);
    expect(effects.some((e) => e.type === 'close')).toBe(true);
    expect(calls.find((c) => c.url.includes('/cli/init')).headers.authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
    const account = accounts().get('me@x.io');
    expect(account).toMatchObject({ displayName: 'me@x.io', email: 'me@x.io', plan: 'GLM Coding Lite' });
    expect(JSON.parse(account.secret)).toMatchObject({ site: 'zai', key: 'id1.sec', plan: 'GLM Coding Lite', locale: 'zh-CN', tz: 'Asia/Shanghai', utc: 480 });
  }, 15000);

  it('an account with no plan of its own signs in to ZCode\'s Start Plan', async () => {
    const jwt = jwtExpiring(3600);
    const { fetch } = routed([
      ['/oauth/cli/init', ok({ flow_id: 'f2', authorize_url: 'https://z.ai/authorize', poll_interval_sec: 0 })],
      ['/oauth/cli/poll/f2', ok({ status: 'ready', token: jwt, zai: { access_token: 'zt' }, user: { email: 'a@x.io' } })],
      ['/api/auth/z/login', ok({ access_token: 'biz' })],
      ['/getCustomerInfo', ok({ organizations: [] })],
      ['/billing/balance', ok(balance())],
    ]);
    const view = await open(fetch);
    await view.press('browser', { site: 'zai' });
    const state = JSON.parse(accounts().get('a@x.io').secret);
    expect(state).toMatchObject({ jwt, plan: 'Start Plan' });
    expect(state.key ?? '').toBe('');
  }, 15000);

  it('a declined sign-in says so and offers the choice again', async () => {
    const { fetch } = routed([
      ['/oauth/cli/init', ok({ flow_id: 'f3', authorize_url: 'https://z.ai/authorize', poll_interval_sec: 0 })],
      ['/oauth/cli/poll/f3', ok({ status: 'failed' })],
    ]);
    const view = await open(fetch);
    await view.press('browser', { site: 'bigmodel' });
    expect(view.state.step).toBe('choose');
    expect(view.state.error).toMatch(/declined on BigModel/);
    expect(accounts()?.size ?? 0).toBe(0);
  }, 15000);
});
