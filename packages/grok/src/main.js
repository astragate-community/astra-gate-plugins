// Grok (SuperGrok / X Premium+) as an Astra v2 provider, through the Grok Build backend and its xAI sign-in.
// Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
import { AstraError, crypto, definePlugin, providers, t, timers, ui } from 'astra';
import { BASE, PROVIDER } from './constants.js';
import { parseImport } from './import.js';
import { DEFAULT_MODELS, listModels } from './models.js';
import { pollDevice, startDevice } from './oidc.js';
import { rateWindow } from './ratelimit.js';
import { transformResponse } from './reply.js';
import { outgoing } from './request.js';
import { SignInExpired, fresh, parseSecret, saverOf } from './session.js';
import { usage } from './usage.js';

const authOf = (account) => async () => parseSecret(await account.secret());
const freshFor = (account, opts) => fresh(authOf(account), saverOf(account.key), opts);
const lapse = (account) => providers.accounts.update(PROVIDER, account.key, { status: 'expired' }).catch(() => {});

const provider = {
  // Every request is Responses at the backend's /v1/responses, signed as the Grok CLI signs it.
  async prepare(req, account) {
    if (req.protocol !== 'responses') throw new AstraError('not_supported', `Grok speaks the Responses API, not ${req.protocol}`);
    if (!account) throw new AstraError('unavailable', 'Grok is not signed in');
    let cred;
    try {
      ({ cred } = await freshFor(account));
    } catch (e) {
      if (e instanceof SignInExpired) await lapse(account);
      throw new AstraError('unavailable', e?.message ?? String(e));
    }
    const { headers, body } = outgoing(req.body, cred.key);
    const path = String(req.path ?? '/v1/responses').split('?')[0].replace(/^\/v1(?=\/)/, '');
    return { url: BASE + path, headers, ...(body === req.body ? {} : { body }) };
  },

  // the account's models, each with the context windows Grok lists; the built-in one when the list can't be had
  async models(account) {
    if (!account) return DEFAULT_MODELS;
    try {
      const { cred } = await freshFor(account);
      return await listModels(cred.key);
    } catch (e) {
      if (e instanceof SignInExpired) await lapse(account);
      return DEFAULT_MODELS;
    }
  },

  // After a 401 / 403: renew the credential (unless it was renewed since) or say the sign-in is over
  async refresh(account) {
    const stored = await authOf(account)();
    if (!stored?.refresh) return 'expired';
    try {
      const { cred } = await freshFor(account, { force: true });
      return cred.key !== stored.key ? 'renewed' : undefined;
    } catch (e) {
      return e instanceof SignInExpired ? 'expired' : undefined;
    }
  },

  transformResponse,

  async usage(account) {
    let cred;
    try {
      ({ cred } = await freshFor(account));
    } catch (e) {
      if (e instanceof SignInExpired) await lapse(account);
      return { error: e?.message ?? String(e), windows: [], signIn: e?.signIn ?? 'kept' };
    }
    const card = await usage(cred.key);
    // what the last 429 says, beside what billing does (it says nothing of a plan's rate limit)
    return { ...card, windows: [...(card.windows ?? []), ...rateWindow(account.key)], signIn: 'kept' };
  },
};

// ---- the sign-in flow (ui.flows): the xAI device code, or a sign-in pasted from Grok Build / CPA

const SLICE_MS = 40_000;

/** Adds the account (or refreshes the one with the same key). */
export async function addAccount(cred) {
  const key = cred.userId || cred.email || crypto.sha256(cred.key).slice(0, 12);
  const info = { key, displayName: cred.email || key, email: cred.email || null, plan: null, status: 'active', secret: JSON.stringify(cred) };
  const existing = await providers.accounts.list(PROVIDER);
  if (existing.some((a) => a.key === key)) await providers.accounts.update(PROVIDER, key, info);
  else await providers.accounts.add(PROVIDER, info);
}

/** Polls one slice; on a credential, adds the account and closes. Changes `state` in place so the flush shows it. */
async function wait(state, ctx) {
  state.error = null;
  state.waiting = true;
  ctx.flush();
  try {
    const cred = await pollDevice(state.device, (ms) => timers.sleep(ms), SLICE_MS);
    state.waiting = false;
    if (!cred) return state;
    await addAccount(cred);
    state.done = true;
    state.device = null;
    ctx.toast({ message: t('signIn.done'), tone: 'success' });
    ctx.close({ ok: true });
  } catch (e) {
    state.waiting = false;
    state.device = null;
    state.error = e?.message ?? String(e);
  }
  return state;
}

export const signIn = ui.defineView({
  init: () => ({ device: null, waiting: false, done: false, error: null }),
  render: (s) => {
    const device = s.device
      ? [
          ui.Text({ value: t('signIn.confirm') }),
          ui.Code({ value: s.device.userCode, copy: true }),
          ui.Link({ label: t('signIn.open'), href: s.device.url }),
          s.waiting ? ui.Spinner({ label: t('signIn.waiting') }) : ui.Button({ label: t('signIn.continue'), variant: 'primary', onPress: 'wait' }),
        ]
      : [ui.Button({ label: t('signIn.start'), variant: 'primary', onPress: 'start' })];
    return ui.Stack({ gap: '4' }, [
      ui.Heading({ value: t('signIn.title'), level: 2 }),
      ...(s.error ? [ui.Alert({ tone: 'danger', message: s.error })] : []),
      ui.Section({ title: t('signIn.device'), description: t('signIn.deviceBody') }, device),
      ui.Section({ title: t('signIn.import'), description: t('signIn.importBody'), collapsible: true, defaultOpen: false }, [
        ui.Form({ onSubmit: 'import' }, [
          ui.Field({ label: t('signIn.json') }, [ui.TextArea({ name: 'json', rows: 6, mono: true, placeholder: '{ … }' })]),
          ui.Button({ label: t('signIn.importSave'), submit: true }),
        ]),
      ]),
    ]);
  },
  actions: {
    start: async (s, _a, ctx) => {
      try {
        s.device = await startDevice();
      } catch (e) {
        s.error = e?.message ?? String(e);
        return s;
      }
      ctx.openExternal(s.device.url);
      return wait(s, ctx);
    },
    wait: (s, _a, ctx) => wait(s, ctx),
    import: async (s, args, ctx) => {
      let cred;
      try {
        cred = parseImport(args?.values?.json);
      } catch (e) {
        return void ctx.fail({ json: e?.message ?? String(e) });
      }
      await addAccount(cred);
      ctx.toast({ message: t('signIn.done'), tone: 'success' });
      ctx.close({ ok: true });
      return s;
    },
  },
});

export default definePlugin({
  activate(ctx) {
    ctx.subscriptions.push(providers.register(PROVIDER, provider));
  },
});
