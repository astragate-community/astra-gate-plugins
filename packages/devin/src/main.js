// Devin as an Astra v2 provider plugin: sign-in, the allowance card and the model list. Devin's chat is a protobuf RPC whose
// reply has to be turned into chat completions; a v2 provider plugin neither sends protobuf nor rewrites the reply, so
// `prepare` refuses (README). Based on an MIT-licensed community plugin (see THIRD_PARTY_NOTICES.md).
import { AstraError, definePlugin, providers } from 'astra';
import { PROVIDER } from './constants.js';
import { snapshotModels } from './models.js';
import { signIn } from './signin.js';
import { usage } from './usage.js';

export { signIn };

const provider = {
  async prepare() {
    throw new AstraError(
      'not_supported',
      "Devin's chat cannot be served by the v2 plugin (Devin speaks a protobuf RPC that a v2 provider cannot send or read back); keep the v1 Devin plugin for chat",
    );
  },
  models: async () => snapshotModels(),
  async usage(account) {
    const key = await account.secret();
    if (!key) throw new Error("Devin isn't signed in");
    const out = await usage(key);
    if (out.error) throw new Error(out.error);
    return out;
  },
};

export default definePlugin({
  activate(ctx) {
    ctx.subscriptions.push(providers.register(PROVIDER, provider));
  },
});
