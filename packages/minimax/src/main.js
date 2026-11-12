// MiniMax Code accounts as Astra v2 providers (one per site: minimax-code for China, minimax-code-global for the
// international site). Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
import { AstraError, crypto, definePlugin, providers, t, ui } from 'astra';
import { PLACEHOLDER_KEY, SITES, chatBase, siteOf } from './constants.js';
import { transformResponse } from './reply.js';
import { builtinModels, hostModel, liveModels } from './models.js';
import { SignInExpired, freshOf, parseSecret, saverOf } from './session.js';
import { finish, pollDevice, startDevice } from './signin.js';
import { usageCard } from './usage.js';

// one conversation id for requests that come with none of their own (a cache: a reloaded plugin makes a new one)
let fallbackSession;
const sessionOf = (headers) => headers['x-mavis-session-id'] || headers['x-session-id'] || (fallbackSession ??= crypto.randomUUID());

const authOf = (account) => async () => parseSecret(await account.secret());
const freshFor = (site, account) => {
  const fresh = freshOf(site, saverOf(site, account.key));
  return (rejected) => fresh(authOf(account), rejected);
};
const lapse = (site, account) => providers.accounts.update(site.id, account.key, { status: 'expired' }).catch(() => {});

function providerOf(site) {
  return {
    // Every chat request is Anthropic messages at MiniMax Code's llm host, sent with MiniMax Code's headers.
    async prepare(req, account) {
      if (req.protocol !== 'anthropic') throw new AstraError('not_supported', `${site.name} speaks Anthropic messages, not ${req.protocol}`);
      if (!account) throw new AstraError('unavailable', `${site.name} isn't signed in`);
      let a;
      try {
        ({ a } = await freshFor(site, account)());
      } catch (e) {
        if (e instanceof SignInExpired) await lapse(site, account);
        throw new AstraError('unavailable', e?.message ?? String(e));
      }
      return {
        url: chatBase(site) + '/messages',
        // always streamed: the reply transform collapses it again for a client that wanted one message
        ...(req.body && typeof req.body === 'object' ? { body: { ...req.body, stream: true } } : {}),
        headers: {
          authorization: 'Bearer ' + a.access,
          'x-api-key': PLACEHOLDER_KEY,
          'user-agent': 'MiniMaxAgent',
          'x-mavis-agent-id': 'main',
          'x-mavis-timezone-offset': String(new Date().getTimezoneOffset() * -60),
          'x-mavis-session-id': sessionOf(req.headers ?? {}),
          'anthropic-version': req.headers?.['anthropic-version'] || '2023-06-01',
        },
      };
    },

    transformResponse,

    // MiniMax Code's live list when it answers, else the built-in one
    async models(account) {
      if (!account) return builtinModels();
      try {
        const { a } = await freshFor(site, account)();
        const ms = await liveModels(site, a.access);
        return ms.length ? ms.map(hostModel) : builtinModels();
      } catch (e) {
        if (e instanceof SignInExpired) await lapse(site, account);
        return builtinModels();
      }
    },

    // After a 401 / 403: a newer sign-in if one was saved meanwhile, else a refresh
    async refresh(account) {
      const stored = await authOf(account)();
      if (!stored?.refresh) return 'expired';
      try {
        const { a } = await freshFor(site, account)(stored.access);
        return a.access !== stored.access ? 'renewed' : undefined;
      } catch (e) {
        return e instanceof SignInExpired ? 'expired' : undefined;
      }
    },

    // the credits and M Plan card
    async usage(account) {
      let got;
      try {
        got = await freshFor(site, account)();
      } catch (e) {
        if (e instanceof SignInExpired) await lapse(site, account);
        return { error: e?.message ?? String(e), ...(e?.signIn ? { signIn: e.signIn } : {}) };
      }
      return usageCard(site, got.a, got.renewed);
    },
  };
}

// ---- the sign-in flow (ui.flows): MiniMax Code's device sign-in, polled in slices a view action can hold

const SLICE_MS = 40_000;

async function save(site, result) {
  const existing = await providers.accounts.list(site.id);
  const info = { key: result.key, displayName: result.displayName, email: result.email, plan: null, status: 'active', secret: JSON.stringify(result.credential) };
  if (existing.some((x) => x.key === result.key)) await providers.accounts.update(site.id, result.key, info);
  else await providers.accounts.add(site.id, info);
}

/**
 * Polls one slice; on a token, saves the account and closes the flow. It changes `state` in place before each flush: the
 * flush shows the session's state as it is now (the code to confirm, the spinner), and the action's return replaces it.
 */
async function wait(state, ctx) {
  const site = SITES[state.site];
  state.error = null;
  state.waiting = true;
  ctx.flush();
  try {
    const got = await pollDevice(site, state.device, SLICE_MS);
    state.waiting = false;
    if (!got) return state;
    await save(site, await finish(site, got));
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
  init: (ctx) => ({ site: siteOf(ctx.params?.provider).id, device: null, waiting: false, done: false, error: null }),
  render: (s) => {
    const site = SITES[s.site];
    const children = [ui.Heading({ value: t('signIn.title', { site: site.name }), level: 2 }), ui.Text({ value: t('signIn.body') })];
    if (s.error) children.push(ui.Alert({ tone: 'danger', message: s.error }));
    if (s.device) {
      children.push(
        ui.Text({ value: t('signIn.confirm') }),
        ui.Code({ value: s.device.userCode, copy: true }),
        ui.Link({ label: t('signIn.open'), href: s.device.url }),
        s.waiting ? ui.Spinner({ label: t('signIn.waiting') }) : ui.Button({ label: t('signIn.continue'), variant: 'primary', onPress: 'wait' }),
      );
    } else if (!s.done) {
      children.push(ui.Button({ label: t('signIn.start'), variant: 'primary', onPress: 'start' }));
    }
    return ui.Stack({ gap: '4' }, children);
  },
  actions: {
    start: async (s, _a, ctx) => {
      const site = SITES[s.site];
      let device;
      try {
        device = await startDevice(site);
      } catch (e) {
        s.error = e?.message ?? String(e);
        return s;
      }
      s.device = device;
      ctx.openExternal(device.url);
      return wait(s, ctx);
    },
    wait: (s, _a, ctx) => wait(s, ctx),
  },
});

export default definePlugin({
  activate(ctx) {
    for (const site of Object.values(SITES)) ctx.subscriptions.push(providers.register(site.id, providerOf(site)));
  },
});
