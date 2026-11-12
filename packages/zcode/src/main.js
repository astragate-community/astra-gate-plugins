// ZCode's GLM Coding Plan as an Astra v2 provider. Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
// Each account's secret is its sign-in state as JSON (session.js); the host keeps it encrypted and hands it to
// `account.secret()`. The browser sign-in runs in the `signIn` flow view: start, open the page, poll until it is done.
import { crypto, definePlugin, providers, timers, t, ui } from 'astra';
import { PROVIDER } from './constants.js';
import { modelsFor } from './models.js';
import { prepare, refresh } from './request.js';
import { transformResponse } from './reply.js';
import { pollFlow, signedIn, startFlow } from './signin.js';
import { planOf } from './routing.js';
import { SITES, siteOf } from './sites.js';
import { jwtExpiry } from './session.js';
import { hex, isTeam, who } from './util.js';
import { usageOf } from './usage.js';

const provider = { prepare, models: (account) => modelsFor(account), refresh, usage: usageOf, transformResponse };

/** Adds the account, or — signing in again to one already there — replaces its credential. */
async function save(key, info, state) {
  const secret = JSON.stringify(state);
  const have = await providers.accounts.list(PROVIDER);
  if (have.some((a) => a.key === key)) await providers.accounts.update(PROVIDER, key, { ...info, status: 'active', secret });
  else await providers.accounts.add(PROVIDER, { key, ...info, secret });
}

const where = (ctx) => ({ locale: ctx.client?.locale, tz: ctx.client?.timeZone, utc: ctx.client?.utcOffset });
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
const siteName = (site) => SITES[site].name + (site === 'bigmodel' ? ' (智谱)' : '');

// the key-account's stable name: a short hash of the key (the key itself is the secret)
const keyName = (key) => 'key-' + crypto.sha256(key).slice(0, 10);

export const signIn = ui.defineView({
  state: { step: 'choose', site: 'zai', error: '', url: '' },
  render: (s) => {
    const failed = s.error ? [ui.Alert({ tone: 'danger', message: s.error })] : [];
    if (s.step === 'waiting')
      return ui.Stack({ gap: '4' }, [
        ui.Heading({ value: t('signIn.waiting', { site: siteName(s.site) }), level: 2 }),
        ui.Text({ value: t('signIn.waiting.body') }),
        ui.Link({ label: t('signIn.open'), href: s.url }),
        ui.Spinner({ label: t('signIn.polling') }),
      ]);
    if (s.step === 'key')
      return ui.Form({ onSubmit: 'submitKey' }, [
        ui.Stack({ gap: '4' }, [
          ui.Heading({ value: t('signIn.key.title'), level: 2 }),
          ...failed,
          ui.Field({ label: t('signIn.key.site') }, ui.Select({ name: 'site', value: 'zai', options: [{ value: 'zai', label: 'Z.ai' }, { value: 'bigmodel', label: 'BigModel (智谱)' }] })),
          ui.Field({ label: t('signIn.key.label'), hint: t('signIn.key.hint'), required: true }, ui.PasswordField({ name: 'key', required: true })),
          ui.Stack({ direction: 'row', gap: '2' }, [
            ui.Button({ label: t('signIn.key.submit'), variant: 'primary', submit: true }),
            ui.Button({ label: t('signIn.back'), variant: 'ghost', onPress: 'back' }),
          ]),
        ]),
      ]);
    return ui.Stack({ gap: '4' }, [
      ui.Heading({ value: t('signIn.title'), level: 2 }),
      ui.Text({ value: t('signIn.body') }),
      ...failed,
      ui.Button({ label: t('signIn.zai'), variant: 'primary', onPress: { action: 'browser', args: { site: 'zai' } } }),
      ui.Button({ label: t('signIn.bigmodel'), variant: 'primary', onPress: { action: 'browser', args: { site: 'bigmodel' } } }),
      ui.Button({ label: t('signIn.key'), variant: 'secondary', onPress: 'key' }),
    ]);
  },
  actions: {
    back: (s) => void Object.assign(s, { step: 'choose', error: '' }),
    key: (s) => void Object.assign(s, { step: 'key', error: '' }),

    // ZCode's flow: the browser signs in to Z.ai or BigModel, and this polls until it is done
    browser: async (s, args, ctx) => {
      const site = siteOf(args.site);
      const poll = 'Bearer ' + hex(crypto.randomBytes(32));
      const device = crypto.randomUUID();
      try {
        const flow = await startFlow(site, poll, device);
        Object.assign(s, { step: 'waiting', site, url: flow.url, error: '' });
        ctx.openExternal(flow.url);
        ctx.flush();
        for (;;) {
          await timers.sleep(flow.interval);
          if (Date.now() > flow.deadline) throw new Error('the sign-in expired; start again');
          const r = await pollFlow(flow, site, poll, device);
          if (r.pending) continue;
          if (r.failed) throw new Error(r.failed);
          const got = r.ready;
          const found = await signedIn(site, got.token, got.jwt, device);
          const state = clean({ site, device, ...found, ...where(ctx) });
          const key = who(got.user);
          await save(key, clean({ displayName: key, email: key.includes('@') ? key : undefined, plan: found.plan }), state);
          ctx.toast({ message: t('signIn.done'), tone: 'success' });
          return ctx.close({ ok: true, account: key, expires: isTeam(found) || found.key ? 0 : jwtExpiry(found.jwt) });
        }
      } catch (e) {
        Object.assign(s, { step: 'choose', error: e.message ?? String(e) });
      }
    },

    // a pasted key (<id>.<secret>) and the site it is from
    submitKey: async (s, _a, ctx) => {
      const site = siteOf(ctx.local.site);
      const key = String(ctx.local.key ?? '').trim();
      if (!key) return void ctx.fail({ key: t('signIn.key.empty') });
      let plan = '';
      try {
        plan = await planOf({ key, base: SITES[site].base });
      } catch {} // the key is kept even when its plan can't be read now
      await save(keyName(key), clean({ displayName: `GLM Coding Plan (${SITES[site].name})`, plan }), { site, key, plan });
      ctx.toast({ message: t('signIn.done'), tone: 'success' });
      ctx.close({ ok: true, account: keyName(key) });
    },
  },
});

export default definePlugin({
  activate(ctx) {
    ctx.subscriptions.push(providers.register(PROVIDER, provider));
  },
});
