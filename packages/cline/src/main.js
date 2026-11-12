// Cline (cline.bot) as an Astra v2 provider. Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
//
// The same sign-in Cline's own client runs — a WorkOS device code the browser approves, traded at Cline's register
// endpoint for the account's token pair — or a plain API key from app.cline.bot. Chat completions go to Cline's gateway
// in OpenAI's format; the model list comes from its recommended-models and cloud-models feeds; usage reads the account's
// credit balance and, on ClinePass, the plan's 5-hour, weekly and monthly limits. The account's secret holds the pair
// (or the key); a token near its end is renewed in `prepare`.
import { AstraError, config, crypto, definePlugin, providers, storage, t, ui } from 'astra';
import { API, PROVIDER } from './constants.js';
import { DEFAULT_MODELS, fetchFeed, hostModels } from './models.js';
import { chatBody, chatHeaders } from './request.js';
import { transformResponse } from './reply.js';
import { fresh } from './session.js';
import { deviceAuthorize, pollDevice, register } from './signin.js';
import { accountUsage } from './usage.js';
import { firstOf, messageOf } from './util.js';

const needAccount = (account) => {
  if (!account) throw new AstraError('invalid_argument', 'Cline needs an account: add one on the provider page');
  return account;
};

const provider = {
  async prepare(req, account) {
    if (req.protocol !== 'chat') throw new AstraError('not_supported', `Cline's gateway speaks chat completions only, not ${req.protocol}`);
    let cred;
    try {
      cred = await fresh(needAccount(account));
    } catch (e) {
      throw e instanceof AstraError ? e : new AstraError(e?.expired ? 'permission_denied' : 'unavailable', String(messageOf(e)).replace(/^Cline: /, ''));
    }
    return { url: `${API}/chat/completions`, headers: chatHeaders(req, cred.bearer), body: chatBody(req.body, config.get().pinUpstream === true, req.stream !== false) };
  },

  transformResponse,

  /** The live list, or the last good one (then the bundled snapshot) when Cline couldn't give one. */
  async models() {
    try {
      const ms = hostModels(await fetchFeed());
      await storage.set('models', ms);
      return ms;
    } catch {
      return (await storage.get('models')) ?? hostModels(DEFAULT_MODELS);
    }
  },

  /** After a 401 / 403: a forced renewal. A refused refresh is the sign-in gone. */
  async refresh(account) {
    try {
      const a = needAccount(account);
      await fresh(a, true);
      return 'renewed';
    } catch (e) {
      return e?.expired ? 'expired' : undefined;
    }
  },

  async usage(account) {
    let cred;
    try {
      cred = await fresh(needAccount(account));
    } catch (e) {
      return { windows: [], error: messageOf(e), ...(e?.expired ? { expired: true } : {}) };
    }
    return accountUsage(cred);
  },
};

// ---- the sign-in flow (ui.flows)

async function save(key, info, secret) {
  const existing = await providers.accounts.list(PROVIDER);
  const patch = { displayName: info.displayName, email: info.email || null, secret };
  if (existing.some((a) => a.key === key)) await providers.accounts.update(PROVIDER, key, { ...patch, status: 'active' });
  else await providers.accounts.add(PROVIDER, { key, ...patch });
}

export const signIn = ui.defineView({
  state: { step: 'choose', url: '', code: '', error: '' },
  render: (s) => {
    if (s.step === 'approve')
      return ui.Stack({ gap: '4' }, [
        ui.Heading({ value: t('signIn.title'), level: 2 }),
        ui.Text({ value: t('signIn.approve') }),
        ...(s.code ? [ui.Code({ value: s.code, copy: true })] : []),
        ui.Link({ label: t('signIn.open'), href: s.url }),
        ui.Spinner({ label: t('signIn.waiting') }),
      ]);
    if (s.step === 'key')
      return ui.Form({ onSubmit: 'saveKey' }, [
        ui.Heading({ value: t('signIn.key.title'), level: 2 }),
        ui.Field({ label: t('signIn.key.label'), hint: t('signIn.key.hint'), required: true }, ui.PasswordField({ name: 'apiKey' })),
        ui.Stack({ direction: 'row', gap: '2' }, [
          ui.Button({ label: t('signIn.back'), variant: 'ghost', onPress: 'back' }),
          ui.Button({ label: t('signIn.key.save'), variant: 'primary', submit: true }),
        ]),
      ]);
    return ui.Stack({ gap: '4' }, [
      ui.Heading({ value: t('signIn.title'), level: 2 }),
      ui.Text({ value: t('signIn.body') }),
      ...(s.error ? [ui.Alert({ tone: 'danger', message: s.error })] : []),
      ui.Button({ label: t('signIn.browser'), variant: 'primary', onPress: 'start' }),
      ui.Button({ label: t('signIn.useKey'), variant: 'secondary', onPress: 'toKey' }),
    ]);
  },
  actions: {
    toKey: (s) => void Object.assign(s, { step: 'key', error: '' }),
    back: (s) => void Object.assign(s, { step: 'choose', error: '' }),
    start: async (s, _a, ctx) => {
      s.error = '';
      try {
        const d = await deviceAuthorize();
        Object.assign(s, { step: 'approve', url: firstOf(d.verification_uri_complete, d.verification_uri, 'https://app.cline.bot'), code: d.user_code ?? '' });
        ctx.flush();
        const p = await register(await pollDevice(d));
        const key = p.accountId || `cline-${crypto.sha256(p.access).slice(0, 12)}`;
        await save(
          key,
          { displayName: key, email: p.email },
          JSON.stringify({ type: 'oauth', access: p.access, refresh: p.refresh, expires: p.expires, uid: p.uid, email: p.email, name: p.name, accountId: p.accountId }),
        );
        ctx.toast({ message: t('signIn.done'), tone: 'success' });
        ctx.close({ ok: true });
      } catch (e) {
        Object.assign(s, { step: 'choose', error: messageOf(e) });
      }
    },
    saveKey: async (s, _a, ctx) => {
      const key = String(ctx.local.apiKey ?? '').trim();
      if (!key) return void ctx.fail({ apiKey: t('signIn.key.empty') });
      await save(`api-${crypto.sha256(key).slice(0, 12)}`, { displayName: t('signIn.key.account') }, JSON.stringify({ type: 'api', key }));
      ctx.toast({ message: t('signIn.done'), tone: 'success' });
      ctx.close({ ok: true });
    },
  },
});

export default definePlugin({
  activate(ctx) {
    ctx.subscriptions.push(providers.register(PROVIDER, provider));
  },
});
