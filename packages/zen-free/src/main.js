// OpenCode Zen's free models as an Astra v2 provider. Based on an MIT-licensed community plugin (see
// THIRD_PARTY_NOTICES.md). The public credential needs no secret: the account only marks the provider as switched on.
import { AstraError, definePlugin, providers, t, ui } from 'astra';
import { PROVIDER, PUBLIC_KEY } from './constants.js';
import { discover } from './discovery.js';
import { expect, transformResponse } from './reply.js';
import { declaredTools, upstreamHeaders, upstreamUrl, withCoreTools } from './request.js';

const provider = {
  async prepare(req) {
    const url = upstreamUrl(req.protocol);
    if (!url) throw new AstraError('not_supported', `OpenCode Zen has no ${req.protocol} endpoint`);
    // what the reply may call: the tools the agent declared (the reply side checks against them)
    expect(req.model, declaredTools(req.body, req.protocol));
    return { url, headers: upstreamHeaders(req), body: withCoreTools(req.body, req.protocol) };
  },
  models: () => discover(),
  transformResponse,
};

const ACCOUNT = { key: 'public', displayName: 'OpenCode Zen Free', plan: 'Free' };

async function enable() {
  const existing = await providers.accounts.list(PROVIDER);
  if (!existing.some((a) => a.key === ACCOUNT.key)) await providers.accounts.add(PROVIDER, { ...ACCOUNT, secret: PUBLIC_KEY });
}

// the sign-in flow (ui.flows): one button, since there is nothing to type
export const signIn = ui.defineView({
  render: () =>
    ui.Stack({ gap: '4' }, [
      ui.Heading({ value: t('signIn.title'), level: 2 }),
      ui.Text({ value: t('signIn.body') }),
      ui.Button({ label: t('signIn.enable'), variant: 'primary', onPress: 'enable' }),
    ]),
  actions: {
    enable: async (_s, _a, ctx) => {
      await enable();
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
