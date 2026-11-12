// Command Code's plans (commandcode.ai) as Astra v2 providers. Based on an MIT-licensed community plugin (see
// THIRD_PARTY_NOTICES.md).
//
// An account is a Command Code API key (Studio's keys page, commandcode.ai/settings/keys). Every plan but Go is served on
// the Provider API (provider `commandcode-plan`): chat completions and Responses at /provider/v1, Anthropic's Messages at
// /provider/v1/messages, the key in Authorization and x-api-key, replies passing straight through. A key does not expire.
// The Go plan has no Provider API, only the CLI's own /alpha/generate in the CLI's format (a JSON object a line): its keys
// are the accounts of the second provider, `commandcode-go`, whose manifest `reply` block has the host cut that reply into
// lines for `transformResponse` (reply.js), which writes chat completion chunks.
import { AstraError, crypto, definePlugin, providers, storage, t, timers, ui } from 'astra';
import { BASE, GENERATE, GO_ID, ID, PATHS } from './constants.js';
import { extraNow, subscriptionOf } from './account.js';
import { accountJSON } from './http.js';
import { builtinModels, goModels, modelsFor } from './models.js';
import { generateBody, generateHeaders, workPlace } from './generate.js';
import { transformResponse } from './reply.js';
import { usage } from './usage.js';

const planKey = (account) => `plan.${account.key}`;
const need = async (account) => {
  const key = account ? await account.secret() : null;
  if (!key) throw new AstraError('invalid_argument', 'Command Code needs an account: add an API key on the provider page');
  return key;
};

/** The plan saved with the account: { id, plan } or null. */
const savedPlan = async (account) => (await storage.get(planKey(account))) ?? null;
const savePlan = async (account, sub, provider = ID) => {
  if (!sub?.plan) return;
  const was = await savedPlan(account);
  if (was?.plan === sub.plan && was?.id === sub.id) return;
  await storage.set(planKey(account), { id: sub.id ?? '', plan: sub.plan });
  try {
    await providers.accounts.update(provider, account.key, { plan: sub.plan });
  } catch {
    // the account was removed meanwhile
  }
};

// the Provider API refusing a Go plan's key: "Your Go plan doesn't include API access. Upgrade to Provider or higher …" (#969)
const GO_NO_API = /\bGo plan doesn.t include API access/i;

const usageOf = (id) => async (account) => {
  const key = await need(account);
  const { out, read } = await usage(key, await savedPlan(account));
  if (read) await savePlan(account, read, id);
  return out;
};

const provider = {
  async prepare(req, account) {
    const key = await need(account);
    const path = PATHS[req.protocol];
    if (!path) throw new AstraError('not_supported', `Command Code has no ${req.protocol} endpoint`);
    if ((await savedPlan(account))?.plan === 'Go')
      throw new AstraError('not_supported', 'The Go plan has no Provider API: add this key to the Command Code Go provider (a Go key is added there by the sign-in flow).');
    return { url: BASE + path, headers: { Authorization: `Bearer ${key}`, 'x-api-key': key } };
  },

  async models(account) {
    if (!account) return builtinModels();
    const key = await account.secret();
    if (!key) return builtinModels();
    let sub = await savedPlan(account);
    if (!sub) {
      sub = await subscriptionOf(key, 9000);
      if (sub) await savePlan(account, sub);
    }
    if (sub?.plan === 'Go') return [];
    return modelsFor(key, sub?.plan ?? '', await extraNow(key));
  },

  // a Go key the plan wasn't known for (billing slow or failing, nothing saved yet) is refused by the Provider API (#969): it is Go
  // from now on, and the account is kept on the Go provider too (v1 asked the chat again on /alpha/generate; the reply of this
  // attempt is the refusal, the next request goes to the Go provider's account)
  async refresh(account, failed) {
    if (!GO_NO_API.test(failed?.body ?? '')) return;
    const key = await need(account);
    await storage.set(planKey(account), { id: '', plan: 'Go' });
    const row = (await providers.accounts.list(ID)).find((a) => a.key === account.key);
    if (!(await providers.accounts.list(GO_ID)).some((a) => a.key === account.key))
      await providers.accounts.add(GO_ID, { key: account.key, displayName: row?.displayName ?? account.key, email: row?.email ?? null, plan: 'Go', secret: key });
    return 'expired';
  },

  usage: usageOf(ID),
};

// The Go plan: a chat completion in the CLI's format to /alpha/generate (the reply is turned back by reply.js).
const goProvider = {
  async prepare(req, account) {
    const key = await need(account);
    if (req.protocol !== 'chat') throw new AstraError('not_supported', `The Command Code Go plan speaks chat completions only, not ${req.protocol}`);
    const chat = { ...(req.body ?? {}), model: req.model ?? req.body?.model };
    return { url: GENERATE, method: 'POST', headers: generateHeaders(key), body: generateBody(chat, workPlace(req.headers)) };
  },

  async models(account) {
    const key = account ? await account.secret() : null;
    return goModels(key ? await extraNow(key) : false);
  },

  transformResponse,
  usage: usageOf(GO_ID),
};

// ---- the sign-in flow (ui.flows): paste a key

// Names a key's account with whoami. Only whoami turning the key down (401, 403) fails: it has answered a key just made
// with a 500, so one that errs is asked again a few times, then passed over.
async function whoami(key) {
  for (let tries = 0; ; tries++) {
    try {
      return (await accountJSON('/alpha/whoami', key))?.user ?? {};
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw new AstraError('permission_denied', "Command Code didn't take the key");
      if (tries >= 2) return {};
      await timers.sleep(1000);
    }
  }
}

export const signIn = ui.defineView({
  state: {},
  render: () =>
    ui.Form({ onSubmit: 'save' }, [
      ui.Heading({ value: t('signIn.title'), level: 2 }),
      ui.Text({ value: t('signIn.body') }),
      ui.Field({ label: t('signIn.key.label'), hint: t('signIn.key.hint'), required: true }, ui.PasswordField({ name: 'apiKey' })),
      ui.Button({ label: t('signIn.save'), variant: 'primary', submit: true }),
    ]),
  actions: {
    save: async (_s, _a, ctx) => {
      const key = String(ctx.local.apiKey ?? '').trim();
      if (!key) return void ctx.fail({ apiKey: t('signIn.key.empty') });
      let me;
      try {
        me = await whoami(key);
      } catch {
        return void ctx.fail({ apiKey: t('signIn.key.refused') });
      }
      const sub = await subscriptionOf(key, 20000);
      const target = sub?.plan === 'Go' ? GO_ID : ID; // a Go key is served by its own provider
      const who = me.userName || me.email || me.id || 'Command Code';
      const accountKey = String(me.id || `key-${crypto.sha256(key).slice(0, 12)}`);
      const info = { displayName: who, email: me.email || null, plan: sub?.plan || null, secret: key };
      const existing = await providers.accounts.list(target);
      if (existing.some((a) => a.key === accountKey)) await providers.accounts.update(target, accountKey, { ...info, status: 'active' });
      else await providers.accounts.add(target, { key: accountKey, ...info });
      if (sub?.plan) await storage.set(`plan.${accountKey}`, { id: sub.id ?? '', plan: sub.plan });
      ctx.toast({ message: t(target === GO_ID ? 'signIn.doneGo' : 'signIn.done', { who }), tone: 'success' });
      ctx.close({ ok: true });
    },
  },
});

export default definePlugin({
  activate(ctx) {
    ctx.subscriptions.push(providers.register(ID, provider), providers.register(GO_ID, goProvider));
  },
});
