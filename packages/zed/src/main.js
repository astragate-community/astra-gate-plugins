// Zed subscriptions (Zed Pro, its trial, a student or business plan) as an Astra v2 provider. Based on an MIT-licensed
// community plugin (see THIRD_PARTY_NOTICES.md), ported from magpie's built-in Zed account, which was read from Zed's
// source (github.com/zed-industries/zed, 1.23.0).
//
// Requests: Zed's /completions takes {provider, model, provider_request} and answers newline-delimited JSON ({"event": <the
// provider's own stream event>} lines plus status lines). `prepare` wraps the request, `transformResponse` (reply.js) turns the
// lines back into the provider's own events, or one whole reply.
import { AstraError, crypto, definePlugin, providers, t, ui } from 'astra';
import { PROVIDER, MODELS, CLOUD, VERSION, WIRE_VENDOR } from './constants.js';
import { cloud, userAgent } from './api.js';
import { modelsOff, orgOf, planName, planOf, stateOf, who } from './account.js';
import { safeParse } from './json.js';
import { fetchModels, hostModel, vendors } from './models.js';
import { providerRequest } from './request.js';
import { transformResponse } from './reply.js';
import { forget, modelToken } from './token.js';
import { SignInExpired } from './api.js';
import { usage } from './usage.js';

const provider = {
  async prepare(req, account) {
    const s = account ? stateOf(await account.secret()) : null;
    if (!s) throw new AstraError('invalid_argument', 'no Zed account is signed in');
    let token;
    try {
      token = await modelToken(s);
    } catch (e) {
      if (e instanceof SignInExpired) throw new AstraError('unavailable', e.message);
      throw e;
    }
    const model = req.model ?? String(req.body?.model ?? '');
    const vendor = vendors.get(model) ?? WIRE_VENDOR[req.protocol];
    return {
      url: CLOUD + '/completions',
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'x-zed-version': VERSION,
        'x-zed-client-supports-status-messages': 'true',
        'x-zed-client-supports-stream-ended-request-completion-status': 'true',
        'User-Agent': userAgent(),
      },
      body: { provider: vendor, model, provider_request: providerRequest(req.protocol, req.body, model) },
    };
  },

  transformResponse,

  // a 401 for a completion is a model token Zed calls stale (or the sign-in itself gone): a new token fixes the first
  async refresh(account) {
    const s = stateOf(await account.secret());
    if (!s) return 'expired';
    forget(s);
    try {
      await modelToken(s, true);
      return 'renewed';
    } catch (e) {
      if (e instanceof SignInExpired) return 'expired';
      throw e;
    }
  },

  async models(account) {
    const s = account ? stateOf(await account.secret()) : null;
    if (!s) return MODELS.map(hostModel);
    try {
      return await fetchModels(s);
    } catch {
      // Zed unreachable, or refusing the sign-in (usage says which): the built-in list stands in
      return MODELS.map(hostModel);
    }
  },

  async usage(account) {
    if (!account) return { error: 'no such Zed account' };
    return usage(await account.secret(), (next) => providers.accounts.update(PROVIDER, account.key, { secret: JSON.stringify(next), plan: planName(next.plan) }));
  },
};

// ---- the sign-in flow (ui.flows): the user id and access token Zed's editor keeps in the system keychain

async function signedIn(userId, access, systemId) {
  const s = { userId, access, systemId };
  const me = safeParse(await cloud('GET', '/client/users/me', s));
  if (!me || typeof me !== 'object') throw new Error('Zed: an unreadable account');
  const org = orgOf(me);
  if (modelsOff(me, org)) throw new Error("Zed: this account's organization has Zed's hosted models turned off");
  const plan = planOf(me, org);
  return { name: who(me), email: me.user?.email ?? null, secret: JSON.stringify({ userId, access, systemId, org, plan, who: who(me) }), plan: planName(plan) };
}

export const signIn = ui.defineView({
  state: {},
  render: () =>
    ui.Form({ onSubmit: 'save' }, [
      ui.Heading({ value: t('signIn.title'), level: 2 }),
      ui.Text({ value: t('signIn.body') }),
      ui.Field({ label: t('signIn.user.label'), required: true }, ui.TextField({ name: 'userId' })),
      ui.Field({ label: t('signIn.token.label'), hint: t('signIn.token.hint'), required: true }, ui.PasswordField({ name: 'access' })),
      ui.Button({ label: t('signIn.save'), variant: 'primary', submit: true }),
    ]),
  actions: {
    save: async (_s, _a, ctx) => {
      const userId = String(ctx.local.userId ?? '').trim();
      const access = String(ctx.local.access ?? '').trim();
      const errors = {};
      if (!userId) errors.userId = t('signIn.user.empty');
      if (!access) errors.access = t('signIn.token.empty');
      if (Object.keys(errors).length) return void ctx.fail(errors);
      let info;
      try {
        info = await signedIn(userId, access, crypto.randomUUID());
      } catch (e) {
        return void ctx.fail({ access: e?.status === 401 ? t('signIn.refused') : String(e?.message ?? e) });
      }
      const existing = await providers.accounts.list(PROVIDER);
      const record = { displayName: info.name, email: info.email, plan: info.plan, secret: info.secret };
      if (existing.some((a) => a.key === userId)) await providers.accounts.update(PROVIDER, userId, { ...record, status: 'active' });
      else await providers.accounts.add(PROVIDER, { key: userId, ...record });
      ctx.toast({ message: t('signIn.done', { who: info.name }), tone: 'success' });
      ctx.close({ ok: true });
    },
  },
});

export default definePlugin({
  activate(ctx) {
    ctx.subscriptions.push(providers.register(PROVIDER, provider));
  },
});
